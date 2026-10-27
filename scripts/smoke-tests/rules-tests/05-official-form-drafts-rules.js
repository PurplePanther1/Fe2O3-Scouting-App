// Emulator tests for the admin draft autosave rules, run against the REAL firestore.rules:
//   officialFormDrafts/{season}_{formType}
//     read / create / update / delete   ONLY an account whose email is leviticus.sietman@gmail.com
//            AND is VERIFIED (the right address UNVERIFIED, a look-alike, a different signed-in
//            user, a team captain and a signed-out client are all denied - for reading too, so
//            nobody else can even see that a draft exists)
//     shape  exactly { fields (list, at most 100), basisVersion (int >= 0), updatedAt (server
//            time), updatedBy (the caller) } and nothing else; the doc id must be
//            {20xx}_{pitScouting|matchScouting}

const { assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const {
  doc, setDoc, getDoc, updateDoc, deleteDoc, serverTimestamp, setLogLevel
} = require('firebase/firestore');

setLogLevel('silent');

const ADMIN_EMAIL = 'leviticus.sietman@gmail.com';

module.exports = {
  name: 'rules: official form drafts (admin-only read/write, verified email, shape)',
  async run(ctx) {
    const env = ctx.rulesEnv;
    const sfx = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const teamId = `odr_${sfx}`;
    const uid = { admin: `adm_${sfx}`, other: `oth_${sfx}`, cap: `cap_${sfx}` };

    await env.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(c.firestore(), 'teams', teamId), { name: 'Draft Rules Team', members: [uid.cap], roles: { [uid.cap]: 'captain' }, permissions: {} });
    });

    const fs = {
      admin: env.authenticatedContext(uid.admin, { email: ADMIN_EMAIL, email_verified: true }).firestore(),
      adminUnverified: env.authenticatedContext(uid.admin, { email: ADMIN_EMAIL, email_verified: false }).firestore(),
      adminNoFlag: env.authenticatedContext(uid.admin, { email: ADMIN_EMAIL }).firestore(),
      adminUpper: env.authenticatedContext(uid.admin, { email: 'Leviticus.Sietman@gmail.com', email_verified: true }).firestore(),
      lookalike: env.authenticatedContext(uid.other, { email: `${ADMIN_EMAIL}.evil.com`, email_verified: true }).firestore(),
      other: env.authenticatedContext(uid.other, { email: 'someone@example.com', email_verified: true }).firestore(),
      cap: env.authenticatedContext(uid.cap, { email: 'cap@example.com', email_verified: true }).firestore(),
      anon: env.unauthenticatedContext().firestore()
    };
    const authUid = { admin: uid.admin, adminUnverified: uid.admin, adminNoFlag: uid.admin, adminUpper: uid.admin, lookalike: uid.other, other: uid.other, cap: uid.cap, anon: uid.other };

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

    const field = (id) => ({ id, label: id, type: 'text', required: false, sortOrder: 0, showInPreview: true });
    const draft = (who, extra = {}) => ({
      fields: [field('notes')], basisVersion: 0, updatedAt: serverTimestamp(), updatedBy: authUid[who], ...extra
    });
    const ref = (who, id = '2099_pitScouting') => doc(fs[who], 'officialFormDrafts', id);

    // ---------- who can write ----------
    await denied('signed-out cannot save a draft', () => setDoc(ref('anon'), draft('anon')));
    await denied('a different signed-in user cannot save a draft', () => setDoc(ref('other'), draft('other')));
    await denied('a team captain is not the admin', () => setDoc(ref('cap'), draft('cap')));
    await denied('the admin address UNVERIFIED cannot save a draft', () => setDoc(ref('adminUnverified'), draft('adminUnverified')));
    await denied('the admin address with NO email_verified claim cannot save a draft', () => setDoc(ref('adminNoFlag'), draft('adminNoFlag')));
    await denied('a different-case admin address cannot save a draft (exact match)', () => setDoc(ref('adminUpper'), draft('adminUpper')));
    await denied('an address that merely STARTS with the admin address cannot save a draft', () => setDoc(ref('lookalike'), draft('lookalike')));
    await ok('the verified admin can create a draft', () => setDoc(ref('admin'), draft('admin')));
    await ok('the verified admin can update it (autosave)', () => setDoc(ref('admin'), draft('admin', { fields: [field('notes'), field('extra')], basisVersion: 3 })));
    await ok('the verified admin can update it with updateDoc too', () => updateDoc(ref('admin'), { fields: [field('only')], basisVersion: 3, updatedAt: serverTimestamp(), updatedBy: uid.admin }));
    await ok('match drafts have their own doc', () => setDoc(ref('admin', '2099_matchScouting'), draft('admin')));

    // ---------- who can read ----------
    await ok('the verified admin can read a draft', () => getDoc(ref('admin')));
    await ok('the verified admin can read a draft that does not exist (opening the screen)', () => getDoc(ref('admin', '2098_pitScouting')));
    await denied('signed-out cannot read a draft', () => getDoc(ref('anon')));
    await denied('another signed-in user cannot read a draft', () => getDoc(ref('other')));
    await denied('a team captain cannot read a draft', () => getDoc(ref('cap')));
    await denied('the admin address UNVERIFIED cannot read a draft', () => getDoc(ref('adminUnverified')));
    await denied('another user cannot even read a draft id that does not exist', () => getDoc(ref('other', '2098_pitScouting')));
    await denied('another user cannot list the drafts', async () => {
      const { collection, getDocs } = require('firebase/firestore');
      await getDocs(collection(fs.other, 'officialFormDrafts'));
    });

    // ---------- shape ----------
    await denied('fields must be a list', () => setDoc(ref('admin', '2097_pitScouting'), draft('admin', { fields: 'nope' })));
    await ok('fields may be empty (the admin removed every field)', () => setDoc(ref('admin', '2097_pitScouting'), draft('admin', { fields: [] })));
    await ok('exactly 100 fields is allowed', () => setDoc(ref('admin', '2097_pitScouting'), draft('admin', { fields: Array.from({ length: 100 }, (_, i) => field(`f${i}`)) })));
    await denied('101 fields is refused', () => setDoc(ref('admin', '2097_pitScouting'), draft('admin', { fields: Array.from({ length: 101 }, (_, i) => field(`f${i}`)) })));
    await denied('basisVersion must be an integer', () => setDoc(ref('admin', '2097_pitScouting'), draft('admin', { basisVersion: '2' })));
    await denied('basisVersion cannot be a fraction', () => setDoc(ref('admin', '2097_pitScouting'), draft('admin', { basisVersion: 1.5 })));
    await denied('basisVersion cannot be negative', () => setDoc(ref('admin', '2097_pitScouting'), draft('admin', { basisVersion: -1 })));
    await ok('basisVersion 0 is fine (nothing published yet)', () => setDoc(ref('admin', '2097_pitScouting'), draft('admin', { basisVersion: 0 })));
    await denied('updatedAt must be the server time', () => setDoc(ref('admin', '2097_pitScouting'), draft('admin', { updatedAt: new Date(0) })));
    await denied('updatedBy must be the caller', () => setDoc(ref('admin', '2097_pitScouting'), draft('admin', { updatedBy: uid.other })));
    await denied('an unexpected extra key is refused', () => setDoc(ref('admin', '2097_pitScouting'), draft('admin', { fromDefault: true })));
    await denied('a missing key is refused (no basisVersion)', () => {
      const d = draft('admin'); delete d.basisVersion;
      return setDoc(ref('admin', '2097_pitScouting'), d);
    });
    await denied('a missing key is refused (no fields)', () => {
      const d = draft('admin'); delete d.fields;
      return setDoc(ref('admin', '2097_pitScouting'), d);
    });
    await denied('the doc id must be {season}_{formType} (wrong type)', () => setDoc(ref('admin', '2099_otherScouting'), draft('admin')));
    await denied('the doc id must be {season}_{formType} (bad season)', () => setDoc(ref('admin', '99_pitScouting'), draft('admin')));
    await denied('the doc id must be {season}_{formType} (free text)', () => setDoc(ref('admin', 'scratch'), draft('admin')));
    await denied('an update that adds a key is refused', () => updateDoc(ref('admin'), { extra: 1, updatedAt: serverTimestamp(), updatedBy: uid.admin }));
    await denied('an update that makes fields too long is refused', () => updateDoc(ref('admin'), { fields: Array.from({ length: 101 }, (_, i) => field(`f${i}`)), updatedAt: serverTimestamp(), updatedBy: uid.admin }));

    // ---------- delete ----------
    await denied('signed-out cannot delete a draft', () => deleteDoc(ref('anon')));
    await denied('another user cannot delete a draft', () => deleteDoc(ref('other')));
    await denied('a team captain cannot delete a draft', () => deleteDoc(ref('cap')));
    await denied('the admin address UNVERIFIED cannot delete a draft', () => deleteDoc(ref('adminUnverified')));
    await ok('the verified admin can delete a draft (Discard / Publish)', () => deleteDoc(ref('admin')));
    await ok('deleting a draft that is already gone is fine', () => deleteDoc(ref('admin')));

    // ---------- nothing leaks into the teams' collections ----------
    await denied('a captain cannot write a draft under their own team either (no such collection)', () => setDoc(doc(fs.cap, 'teams', teamId, 'officialFormDrafts', '2099_pitScouting'), draft('cap')));

    if (failures.length > 0) throw new Error(`${failures.length} rule check(s) failed (${passed} passed):\n  ${failures.join('\n  ')}`);
    ctx.log(`${passed} checks`);
  }
};
