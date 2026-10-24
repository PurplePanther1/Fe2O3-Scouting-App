// Emulator tests (REAL firestore.rules) for the SHARED caches — events/{code}, eventCache/season_<y>,
// teamDetails/<n> — pinning the facts the "Refresh cached data" design rests on (js/data-refresh.js):
//   - NOBODY can DELETE them (events/ is "delete: false"; for eventCache/ and teamDetails/ the
//     "write" rule needs request.resource, which a delete doesn't have). So the app can never
//     "clear" a shared cache by deleting it — and the existing cache-clearing code that deletes a
//     bad teamDetails doc with the error swallowed has always been a silent no-op.
//   - any SIGNED-IN user can already overwrite them or reset their cachedAt (a merge update that keeps
//     name / ftcTeams / events). That is existing behavior; the button deliberately does NOT use it:
//     it writes nothing to these docs (a per-device "refreshed at" stamp makes the device treat older
//     copies as expired), so it adds no power and affects no other user.
//   - signed-out users can do none of it.

const { assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, setDoc, updateDoc, deleteDoc, writeBatch, Timestamp, deleteField, setLogLevel } = require('firebase/firestore');

setLogLevel('silent');

module.exports = {
  name: 'rules: shared caches (events, eventCache, teamDetails) can never be deleted; a signed-in user could already mark them stale; signed-out users can do nothing',
  async run(ctx) {
    const env = ctx.rulesEnv;
    const sfx = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const code = `RC${sfx}`;
    const season = `s${sfx}`;
    const tid = `99${sfx}`;
    await env.withSecurityRulesDisabled(async (c) => {
      const f = c.firestore();
      await setDoc(doc(f, 'events', code), {
        name: 'Cached Event', season: 2026, ftcTeams: [{ teamNumber: 1, name: 'One' }], cachedAt: Timestamp.now(),
        schedule: [], scheduleSeason: '2026', scheduleCachedAt: Timestamp.now(),
        matchScores: { 1: {} }, matchScoresSeason: 2026, matchScoresCachedAt: Timestamp.now(), matchScoresFinished: true
      });
      await setDoc(doc(f, 'eventCache', `season_${season}`), { events: [{ code: 'A' }], cachedAt: Timestamp.now() });
      await setDoc(doc(f, 'teamDetails', tid), { teamNumber: 1, name: 'One', season: '2026', cachedAt: Timestamp.now() });
    });
    const authed = env.authenticatedContext(`rc_${sfx}`).firestore();
    const anon = env.unauthenticatedContext().firestore();

    const failures = [];
    let passed = 0;
    async function check(label, f, expect) {
      try {
        await (expect === 'fail' ? assertFails(f()) : assertSucceeds(f()));
        passed++;
      } catch (err) {
        failures.push(`${label}  (expected ${expect === 'fail' ? 'DENY' : 'ALLOW'}): ${String(err.message || err).split('\n')[0]}`);
      }
    }
    const ok = (l, f) => check(l, f, 'succeed');
    const denied = (l, f) => check(l, f, 'fail');
    const epoch = Timestamp.fromMillis(0);

    await ok('(existing power) a signed-in user can mark an event stale (timestamps reset, scores not finished)', () =>
      updateDoc(doc(authed, 'events', code), { invalidated: true, scheduleCachedAt: epoch, matchScoresCachedAt: epoch, matchScoresFinished: false }));
    await ok('a fresh cacheEventToFirestore() write re-caches it', () =>
      setDoc(doc(authed, 'events', code), { name: 'Cached Event', ftcTeams: [{ teamNumber: 1, name: 'One' }], invalidated: false, cachedAt: Timestamp.now() }, { merge: true }));
    await ok('(existing power) reset a season event list cachedAt', () => updateDoc(doc(authed, 'eventCache', `season_${season}`), { cachedAt: epoch }));
    await ok('(existing power) reset team stats cachedAt in a batch', async () => {
      const b = writeBatch(authed);
      b.update(doc(authed, 'teamDetails', tid), { cachedAt: epoch });
      await b.commit();
    });

    await denied('events/ docs cannot be deleted', () => deleteDoc(doc(authed, 'events', code)));
    await denied('eventCache/ docs cannot be deleted', () => deleteDoc(doc(authed, 'eventCache', `season_${season}`)));
    await denied('teamDetails/ docs cannot be deleted either (so the existing swallowed delete in getCachedTeamDetail() never worked)', () => deleteDoc(doc(authed, 'teamDetails', tid)));
    await denied('an update that would remove ftcTeams is refused (a required field cannot be dropped)', () =>
      updateDoc(doc(authed, 'events', code), { ftcTeams: deleteField() }));
    await denied('signed-out users cannot mark anything stale', () => updateDoc(doc(anon, 'events', code), { invalidated: true }));
    await denied('signed-out users cannot touch teamDetails', () => updateDoc(doc(anon, 'teamDetails', tid), { cachedAt: epoch }));

    if (failures.length > 0) throw new Error(`${failures.length} rules check(s) failed (${passed} passed):\n  ${failures.join('\n  ')}`);
    ctx.log(`${passed} checks`);
  }
};
