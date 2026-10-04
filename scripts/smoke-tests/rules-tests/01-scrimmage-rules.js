// Emulator tests for the scrimmage rules, run against the REAL firestore.rules.
// Who-can-do-what is exactly what the phase-1 spec asks for:
//   plain member: cannot create/delete/rename a scrimmage, CAN add roster teams
//     and edit a roster name, cannot remove roster teams, cannot lower
//     matchCount, cannot change season.
//   permission holder (canManageScrimmages, no canEditOtherEntries): can
//     create/rename/delete and cascade-delete OTHER people's scrimmage entries.
//   entries without a scrimmageId are unaffected by any of it.

const { assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const {
  doc, setDoc, getDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, deleteField, setLogLevel
} = require('firebase/firestore');

// Every denied-on-purpose write makes the SDK log a PERMISSION_DENIED stream error — expected here.
setLogLevel('silent');

module.exports = {
  name: 'rules: scrimmages (permission gate, roster, matchCount, entry cascade)',
  async run(ctx) {
    const env = ctx.rulesEnv;
    const sfx = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const teamId = `rt_${sfx}`;
    const uid = { cap: `cap_${sfx}`, mgr: `mgr_${sfx}`, mem1: `m1_${sfx}`, mem2: `m2_${sfx}`, out: `out_${sfx}` };

    await env.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(c.firestore(), 'teams', teamId), {
        name: 'Rules Team',
        members: [uid.cap, uid.mgr, uid.mem1, uid.mem2],
        roles: { [uid.cap]: 'captain' },
        // mgr holds ONLY canManageScrimmages — deliberately not canEditOtherEntries.
        permissions: { [uid.mgr]: { canManageScrimmages: true } }
      });
    });

    const db = {};
    Object.keys(uid).forEach(k => { db[k] = env.authenticatedContext(uid[k]).firestore(); });

    const scrimRef = (who, id) => doc(db[who], 'teams', teamId, 'scrimmages', id);
    const pitRef = (who, id) => doc(db[who], 'teams', teamId, 'pitScouting', id);
    const matchRef = (who, id) => doc(db[who], 'teams', teamId, 'matchScouting', id);
    const validScrim = (id, extra = {}) => ({
      name: 'Test Scrimmage', season: '2026', eventCode: `SCRIM-${id}`,
      createdAt: serverTimestamp(), teams: {}, matchCount: 0, ...extra
    });
    const rosterEntry = (n, name) => ({ number: n, name, manualName: name, linked: false, location: '', opr: null, linkedAt: null });
    const scrimEntry = (id, who, n, extra = {}) => ({
      eventCode: `SCRIM-${id}`, scrimmageId: id, teamNumber: n, teamId, season: '2026',
      scoutedBy: uid[who], scoutedByName: who, checkpoint: { notes: 'x' }, ...extra
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

    // ---------- create ----------
    await denied('plain member cannot create a scrimmage', () => setDoc(scrimRef('mem1', 'a1'), validScrim('a1')));
    await denied('non-member cannot create a scrimmage', () => setDoc(scrimRef('out', 'a2'), validScrim('a2')));
    await ok('permission holder can create', () => setDoc(scrimRef('mgr', 'S1'), validScrim('S1')));
    await ok('captain can create', () => setDoc(scrimRef('cap', 'S2'), validScrim('S2')));
    await ok('create with a valid date', () => setDoc(scrimRef('mgr', 'S3'), validScrim('S3', { date: '2026-11-15' })));
    await denied('create: eventCode must be SCRIM-<id>', () => setDoc(scrimRef('mgr', 'b1'), validScrim('b1', { eventCode: 'SCRIM-other' })));
    await denied('create: empty name', () => setDoc(scrimRef('mgr', 'b2'), validScrim('b2', { name: '' })));
    await denied('create: 61-char name', () => setDoc(scrimRef('mgr', 'b3'), validScrim('b3', { name: 'x'.repeat(61) })));
    await denied('create: non-zero matchCount', () => setDoc(scrimRef('mgr', 'b4'), validScrim('b4', { matchCount: 3 })));
    await denied('create: pre-populated roster', () => setDoc(scrimRef('mgr', 'b5'), validScrim('b5', { teams: { 1: rosterEntry(1, 'a') } })));
    await denied('create: unexpected extra field', () => setDoc(scrimRef('mgr', 'b6'), validScrim('b6', { creator: uid.mgr })));
    await denied('create: malformed season', () => setDoc(scrimRef('mgr', 'b7'), validScrim('b7', { season: '26' })));
    await denied('create: malformed date', () => setDoc(scrimRef('mgr', 'b8'), validScrim('b8', { date: '11/15/2026' })));
    await denied('create: createdAt must be the server time', () => setDoc(scrimRef('mgr', 'b9'), validScrim('b9', { createdAt: new Date(0) })));

    // ---------- read ----------
    await ok('member can read a scrimmage', () => getDoc(scrimRef('mem1', 'S1')));
    await denied('non-member cannot read a scrimmage', () => getDoc(scrimRef('out', 'S1')));

    // ---------- rename / date / season ----------
    await denied('plain member cannot rename', () => updateDoc(scrimRef('mem1', 'S1'), { name: 'Hacked' }));
    await denied('plain member cannot change the date', () => updateDoc(scrimRef('mem1', 'S1'), { date: '2026-12-01' }));
    await ok('permission holder can rename', () => updateDoc(scrimRef('mgr', 'S1'), { name: 'Renamed' }));
    await ok('permission holder can set the date', () => updateDoc(scrimRef('mgr', 'S1'), { date: '2026-12-01' }));
    await ok('permission holder can clear the date', () => updateDoc(scrimRef('mgr', 'S1'), { date: deleteField() }));
    await denied('permission holder cannot use a 61-char name', () => updateDoc(scrimRef('mgr', 'S1'), { name: 'y'.repeat(61) }));
    await denied('permission holder cannot use a malformed date', () => updateDoc(scrimRef('mgr', 'S1'), { date: 'tomorrow' }));
    // season: its own narrow manager-only branch (name/date/season), eventCode stays immutable.
    await denied('plain member cannot change season', () => updateDoc(scrimRef('mem1', 'S1'), { season: '2025' }));
    await denied('non-member cannot change season', () => updateDoc(scrimRef('out', 'S1'), { season: '2025' }));
    await ok('permission holder can change season', () => updateDoc(scrimRef('mgr', 'S1'), { season: '2025' }));
    await ok('captain can change season', () => updateDoc(scrimRef('cap', 'S1'), { season: '2024' }));
    await ok('manager can change name + date + season in one write', () =>
      updateDoc(scrimRef('mgr', 'S1'), { name: 'All Three', date: '2026-12-02', season: '2026' }));
    await denied('season must be a 20xx string (two digits)', () => updateDoc(scrimRef('mgr', 'S1'), { season: '26' }));
    await denied('season must be a string (number rejected)', () => updateDoc(scrimRef('mgr', 'S1'), { season: 2026 }));
    await denied('season must be 4 digits starting 20 (1999)', () => updateDoc(scrimRef('mgr', 'S1'), { season: '1999' }));
    await denied('season cannot ride along with a roster edit by a plain member', () =>
      updateDoc(scrimRef('mem1', 'S1'), { season: '2025', 'teams.1': rosterEntry(1, 'x') }));
    await denied('season cannot ride along with a matchCount bump by a plain member', () =>
      updateDoc(scrimRef('mem1', 'S1'), { season: '2025', matchCount: 3 }));
    await denied('nobody can change eventCode (plain member)', () => updateDoc(scrimRef('mem1', 'S1'), { eventCode: 'SCRIM-zzz' }));
    await denied('nobody can change eventCode (permission holder)', () => updateDoc(scrimRef('mgr', 'S1'), { eventCode: 'SCRIM-zzz' }));
    await denied('nobody can change eventCode (captain, even alongside a valid season)', () =>
      updateDoc(scrimRef('cap', 'S1'), { eventCode: 'SCRIM-zzz', season: '2026' }));
    // matchCount: a season change deletes every entry, so the manager's write resets it to 0 too.
    await ok('(seed) a member raises matchCount to 4', () => updateDoc(scrimRef('mem1', 'S1'), { matchCount: 4 }));
    await ok('manager can set matchCount to 0 on its own', () => updateDoc(scrimRef('mgr', 'S1'), { matchCount: 0 }));
    await ok('(seed) a member raises matchCount to 6', () => updateDoc(scrimRef('mem1', 'S1'), { matchCount: 6 }));
    await ok('manager can set matchCount 0 TOGETHER with a season change', () => updateDoc(scrimRef('mgr', 'S1'), { season: '2025', matchCount: 0 }));
    await ok('captain can set matchCount 0 together with name + date + season', () =>
      updateDoc(scrimRef('cap', 'S1'), { name: 'Reset By Captain', date: '2026-12-03', season: '2026', matchCount: 0 }));
    await ok('manager can set a non-zero matchCount (any int 0..9999)', () => updateDoc(scrimRef('mgr', 'S1'), { matchCount: 12 }));
    await ok('...and back to 0', () => updateDoc(scrimRef('mgr', 'S1'), { matchCount: 0 }));
    await denied('manager cannot set a non-integer matchCount', () => updateDoc(scrimRef('mgr', 'S1'), { matchCount: 5.5 }));
    await denied('manager cannot set a string matchCount', () => updateDoc(scrimRef('mgr', 'S1'), { matchCount: '5' }));
    await denied('manager cannot set a negative matchCount', () => updateDoc(scrimRef('mgr', 'S1'), { matchCount: -1 }));
    await denied('manager cannot set matchCount above 9999', () => updateDoc(scrimRef('mgr', 'S1'), { matchCount: 10000 }));
    await denied('manager cannot set a bad matchCount together with a valid season', () => updateDoc(scrimRef('mgr', 'S1'), { season: '2026', matchCount: 10000 }));
    await denied('eventCode stays immutable even alongside a valid matchCount reset', () => updateDoc(scrimRef('mgr', 'S1'), { eventCode: 'SCRIM-zzz', matchCount: 0 }));
    await denied('a plain member still cannot use the manage branch to reset matchCount alongside a season', () => updateDoc(scrimRef('mem1', 'S1'), { season: '2025', matchCount: 0 }));

    // ---------- roster ----------
    await ok('plain member can add a roster team', () => updateDoc(scrimRef('mem1', 'S1'), { 'teams.1234': rosterEntry(1234, 'Robo Cats') }));
    await ok('another plain member can add a roster team', () => updateDoc(scrimRef('mem2', 'S1'), { 'teams.5678': rosterEntry(5678, 'Gear Heads') }));
    await ok('plain member can edit a roster name (even one they did not add)', () =>
      updateDoc(scrimRef('mem2', 'S1'), { 'teams.1234.name': 'Robo Cats II', 'teams.1234.manualName': 'Robo Cats II' }));
    await denied('non-member cannot edit the roster', () => updateDoc(scrimRef('out', 'S1'), { 'teams.9999': rosterEntry(9999, 'x') }));
    await denied('plain member cannot remove a roster team (deleteField)', () => updateDoc(scrimRef('mem1', 'S1'), { 'teams.1234': deleteField() }));
    await denied('plain member cannot remove a team by replacing the whole map', () =>
      updateDoc(scrimRef('mem1', 'S1'), { teams: { 5678: rosterEntry(5678, 'Gear Heads') } }));
    await denied('plain member cannot wipe the roster', () => updateDoc(scrimRef('mem1', 'S1'), { teams: {} }));
    await denied('roster edit cannot ride along with a rename', () =>
      updateDoc(scrimRef('mem1', 'S1'), { 'teams.4321': rosterEntry(4321, 'z'), name: 'Sneaky' }));
    const big = {};
    for (let i = 1; i <= 101; i++) big[i] = rosterEntry(i, `t${i}`);
    await denied('roster size is capped at 100', () => updateDoc(scrimRef('mem1', 'S3'), { teams: big }));
    await ok('permission holder can remove a roster team (zero-entry check is client-side)', () =>
      updateDoc(scrimRef('mgr', 'S1'), { 'teams.5678': deleteField() }));

    // ---------- matchCount ----------
    await ok('plain member can raise matchCount 0 -> 5', () => updateDoc(scrimRef('mem1', 'S1'), { matchCount: 5 }));
    await denied('plain member cannot lower matchCount 5 -> 3', () => updateDoc(scrimRef('mem2', 'S1'), { matchCount: 3 }));
    await denied('matchCount must be an integer', () => updateDoc(scrimRef('mem1', 'S1'), { matchCount: 5.5 }));
    await denied('matchCount is capped at 9999', () => updateDoc(scrimRef('mem1', 'S1'), { matchCount: 10000 }));
    await denied('matchCount bump cannot ride along with a rename', () => updateDoc(scrimRef('mem1', 'S1'), { matchCount: 9, name: 'Sneaky' }));
    await denied('non-member cannot bump matchCount', () => updateDoc(scrimRef('out', 'S1'), { matchCount: 9 }));
    await ok('plain member can raise matchCount 5 -> 9', () => updateDoc(scrimRef('mem2', 'S1'), { matchCount: 9 }));

    // ---------- entries: creation is unchanged (any member) ----------
    await ok('member creates a scrimmage pit entry', () => setDoc(pitRef('mem1', 'pit1'), scrimEntry('S1', 'mem1', 1234)));
    await ok('member creates a scrimmage match entry', () => setDoc(matchRef('mem1', 'm1'), scrimEntry('S1', 'mem1', 1234, { matchNumber: 4 })));
    await ok('member creates a second scrimmage match entry', () => setDoc(matchRef('mem1', 'm2'), scrimEntry('S1', 'mem1', 1234, { matchNumber: 5 })));
    // A REAL-event entry (no scrimmageId) by the same member.
    await ok('member creates a real-event entry', () => setDoc(pitRef('mem1', 'real1'), {
      eventCode: 'USTXHOU', teamNumber: 21865, teamId, season: '2026', scoutedBy: uid.mem1, checkpoint: { notes: 'x' }
    }));
    // Entries that must NOT be deletable by the scrimmage path.
    await ok('seed: entry whose scrimmageId points at no scrimmage', () => setDoc(pitRef('mem1', 'ghost1'), scrimEntry('nope', 'mem1', 7)));
    await ok('seed: entry with a mismatched eventCode', () => setDoc(pitRef('mem1', 'mismatch1'), scrimEntry('S1', 'mem1', 8, { eventCode: 'USTXHOU' })));

    // ---------- entries: roster rename touches no entry ----------
    await ok('another member renames a roster team', () =>
      updateDoc(scrimRef('mem2', 'S1'), { 'teams.1234.name': 'Renamed Again', 'teams.1234.manualName': 'Renamed Again' }));
    await ok('entries still read fine after a rename (they store no team name)', async () => {
      const snap = await getDoc(pitRef('mem2', 'pit1'));
      if (!snap.exists() || 'teamName' in snap.data()) throw new Error('entry unexpectedly changed or carries a name');
    });

    // ---------- entries: who may delete ----------
    await denied('plain member cannot delete someone else\'s scrimmage entry', () => deleteDoc(pitRef('mem2', 'pit1')));
    await denied('plain member cannot delete someone else\'s scrimmage match entry', () => deleteDoc(matchRef('mem2', 'm1')));
    await denied('permission holder cannot delete a real-event entry (no scrimmageId)', () => deleteDoc(pitRef('mgr', 'real1')));
    await denied('permission holder cannot delete an entry pointing at a missing scrimmage', () => deleteDoc(pitRef('mgr', 'ghost1')));
    await denied('permission holder cannot delete an entry whose eventCode != SCRIM-<scrimmageId>', () => deleteDoc(pitRef('mgr', 'mismatch1')));
    await denied('plain member cannot delete a real-event entry they do not own', () => deleteDoc(pitRef('mem2', 'real1')));
    await ok('owner can still delete their own real-event entry', async () => {
      await setDoc(pitRef('mem1', 'real2'), { eventCode: 'USTXHOU', teamNumber: 1, teamId, season: '2026', scoutedBy: uid.mem1, checkpoint: {} });
      await deleteDoc(pitRef('mem1', 'real2'));
    });

    // ---------- removing a team's entries one by one (Remove team, phase-1 fixes) ----------
    // deleteEntryWithNotice() (live-entry-sync.js) first tries to stamp a
    // deletionNotice on the entry and then deletes it; the stamp is best-effort.
    // A manager WITHOUT canEditOtherEntries is denied the stamp but must still
    // be able to delete — that is the path "remove a team that has entries" uses.
    await ok('seed: an entry the manager will remove one-by-one', () => setDoc(pitRef('mem1', 'del1'), scrimEntry('S1', 'mem1', 1234)));
    await denied('manager without canEditOtherEntries cannot stamp a deletionNotice (best-effort step)', () =>
      updateDoc(pitRef('mgr', 'del1'), { deletionNotice: { deletedByName: 'mgr', deletedByUid: uid.mgr, deletedAt: serverTimestamp() } }));
    await ok('...but can still delete it (scrimmage cascade clause)', () => deleteDoc(pitRef('mgr', 'del1')));
    await ok('seed: a match entry for the same flow', () => setDoc(matchRef('mem1', 'del2'), scrimEntry('S1', 'mem1', 1234, { matchNumber: 9 })));
    await ok('manager deletes a draft (no checkpoint/scoutedBy) scrimmage entry too', async () => {
      await setDoc(pitRef('mem1', 'draft1'), { eventCode: 'SCRIM-S1', scrimmageId: 'S1', teamNumber: 1234, teamId, season: '2026', activeEditors: {} });
      await deleteDoc(pitRef('mgr', 'draft1'));
    });
    await ok('manager deletes the match entry', () => deleteDoc(matchRef('mgr', 'del2')));

    // ---------- cascade: permission holder (no canEditOtherEntries) ----------
    await ok('permission holder cascade-deletes others\' scrimmage entries (batch)', async () => {
      const b = writeBatch(db.mgr);
      b.delete(pitRef('mgr', 'pit1'));
      b.delete(matchRef('mgr', 'm1'));
      b.delete(matchRef('mgr', 'm2'));
      await b.commit();
    });
    await ok('...then deletes the scrimmage doc last', () => deleteDoc(scrimRef('mgr', 'S1')));
    // (hence the client deletes entries FIRST and the scrimmage doc LAST)
    await ok('seed: an orphan entry for the deleted scrimmage', () => setDoc(pitRef('mem1', 'orphan1'), scrimEntry('S1', 'mem1', 10)));
    await denied('after the scrimmage doc is gone, the cascade clause no longer applies', () => deleteDoc(pitRef('mgr', 'orphan1')));

    // ---------- delete gate ----------
    await ok('seed: a scrimmage for the delete-gate checks', () => setDoc(scrimRef('mgr', 'S4'), validScrim('S4')));
    await denied('plain member cannot delete a scrimmage', () => deleteDoc(scrimRef('mem1', 'S4')));
    await denied('non-member cannot delete a scrimmage', () => deleteDoc(scrimRef('out', 'S4')));
    await ok('captain can cascade-delete scrimmage entries too (existing path)', async () => {
      await setDoc(pitRef('mem1', 'capdel1'), scrimEntry('S4', 'mem1', 11));
      await deleteDoc(pitRef('cap', 'capdel1'));
    });
    await ok('permission holder can delete a scrimmage they did not create (no creator tracking)', () => deleteDoc(scrimRef('mgr', 'S2')));
    await ok('captain can delete a scrimmage', () => deleteDoc(scrimRef('cap', 'S4')));

    // ---------- losing the permission ----------
    await ok('revoke: permission removed from the team doc', async () => {
      await env.withSecurityRulesDisabled(async (c) => {
        await updateDoc(doc(c.firestore(), 'teams', teamId), { permissions: {} });
      });
    });
    await denied('after revocation the former holder cannot delete a scrimmage (even one they created)', () => deleteDoc(scrimRef('mgr', 'S3')));
    await denied('after revocation the former holder cannot rename', () => updateDoc(scrimRef('mgr', 'S3'), { name: 'nope' }));

    if (failures.length > 0) {
      throw new Error(`${failures.length} rules check(s) failed (${passed} passed):\n  - ${failures.join('\n  - ')}`);
    }
    ctx.log(`${passed} rules checks passed`);
  }
};
