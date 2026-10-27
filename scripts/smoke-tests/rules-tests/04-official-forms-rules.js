// Emulator tests for the official-forms rules, run against the REAL firestore.rules:
//   officialForms/{season}_{formType}  (+ /versions/{n})
//     read   any signed-in user (a signed-out client can't)
//     write  ONLY an account whose email is leviticus.sietman@gmail.com AND is VERIFIED
//            (a different user, the right address UNVERIFIED, a look-alike address and a
//            signed-out client are all denied); version starts at 1 and goes up by exactly 1;
//            the history copy must be written together with, and match, the parent.
//   teams/{id}/formSnapshots  captain / canEditTemplates only; create-once; shape checked
//   teams/{id}/formConfig     the new version fields (baseVersion / handledVersion / retiredFields)

const { assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const {
  doc, setDoc, getDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp, setLogLevel
} = require('firebase/firestore');

setLogLevel('silent');

const ADMIN_EMAIL = 'leviticus.sietman@gmail.com';

module.exports = {
  name: 'rules: official forms (admin-only publish, verified email, versioning), formSnapshots, formConfig version fields',
  async run(ctx) {
    const env = ctx.rulesEnv;
    const sfx = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const teamId = `of_${sfx}`;
    const soloTeamId = `ofsolo_${sfx}`;
    const uid = { admin: `adm_${sfx}`, other: `oth_${sfx}`, cap: `cap_${sfx}`, forms: `frm_${sfx}`, mem: `mem_${sfx}`, out: `out_${sfx}`, solo: `solo_${sfx}` };

    await env.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(c.firestore(), 'teams', teamId), {
        name: 'Official Forms Team',
        members: [uid.cap, uid.forms, uid.mem],
        roles: { [uid.cap]: 'captain' },
        permissions: { [uid.forms]: { canEditTemplates: true } }
      });
      // A one-member team whose only member is NOT a captain / forms editor: the "last member
      // may delete the subcollection" branch.
      await setDoc(doc(c.firestore(), 'teams', soloTeamId), { name: 'Solo', members: [uid.solo], roles: {}, permissions: {} });
    });

    const fs = {
      admin: env.authenticatedContext(uid.admin, { email: ADMIN_EMAIL, email_verified: true }).firestore(),
      adminUnverified: env.authenticatedContext(uid.admin, { email: ADMIN_EMAIL, email_verified: false }).firestore(),
      adminNoFlag: env.authenticatedContext(uid.admin, { email: ADMIN_EMAIL }).firestore(),
      adminUpper: env.authenticatedContext(uid.admin, { email: 'Leviticus.Sietman@gmail.com', email_verified: true }).firestore(),
      lookalike: env.authenticatedContext(uid.other, { email: `${ADMIN_EMAIL}.evil.com`, email_verified: true }).firestore(),
      other: env.authenticatedContext(uid.other, { email: 'someone@example.com', email_verified: true }).firestore(),
      anon: env.unauthenticatedContext().firestore(),
      cap: env.authenticatedContext(uid.cap).firestore(),
      forms: env.authenticatedContext(uid.forms).firestore(),
      mem: env.authenticatedContext(uid.mem).firestore(),
      out: env.authenticatedContext(uid.out).firestore(),
      solo: env.authenticatedContext(uid.solo).firestore()
    };

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

    // ---------- officialForms ----------
    const season = '2099';
    const formId = `${season}_pitScouting`;
    const field = (id) => ({ id, label: id, type: 'text', required: false, sortOrder: 0, showInPreview: true });
    // The uid each context above signs in as.
    const authUid = { admin: uid.admin, adminUnverified: uid.admin, adminNoFlag: uid.admin, adminUpper: uid.admin, lookalike: uid.other, other: uid.other, cap: uid.cap, anon: uid.other };
    const form = (who, version, extra = {}) => ({
      season, formType: 'pitScouting', version, fields: [field('notes')],
      publishedAt: serverTimestamp(), publishedBy: authUid[who], ...extra
    });
    const formRef = (who, id = formId) => doc(fs[who], 'officialForms', id);
    const versionRef = (who, n, id = formId) => doc(fs[who], 'officialForms', id, 'versions', String(n));
    // The publish the app does: parent + history copy in one atomic write.
    const publish = (who, version, extra = {}, id = formId) => {
      const batch = writeBatch(fs[who]);
      batch.set(formRef(who, id), form(who, version, extra));
      batch.set(versionRef(who, version, id), form(who, version, extra));
      return batch.commit();
    };

    // create
    await denied('signed-out cannot publish', () => publish('anon', 1));
    await denied('a different signed-in user cannot publish', () => publish('other', 1));
    await denied('the admin address UNVERIFIED cannot publish', () => publish('adminUnverified', 1));
    await denied('the admin address with NO email_verified claim cannot publish', () => publish('adminNoFlag', 1));
    await denied('a different-case admin address cannot publish (exact match)', () => publish('adminUpper', 1));
    await denied('an address that merely STARTS with the admin address cannot publish', () => publish('lookalike', 1));
    await denied('a team captain is not the admin', () => publish('cap', 1));
    await denied('admin: first publish must be version 1 (not 2)', () => publish('admin', 2));
    await denied('admin: version 0 is invalid', () => publish('admin', 0));
    await ok('verified admin can publish version 1 (parent + history together)', () => publish('admin', 1));

    // read
    await ok('any signed-in user can read an official form', () => getDoc(formRef('other')));
    await ok('a team member can read it too', () => getDoc(formRef('mem')));
    await ok('a signed-in user can read the version history', () => getDoc(versionRef('other', 1)));
    await denied('a signed-out client cannot read an official form', () => getDoc(formRef('anon')));
    await denied('a signed-out client cannot read the history', () => getDoc(versionRef('anon', 1)));

    // update: +1 only
    await denied('another user cannot publish version 2', () => publish('other', 2));
    await denied('admin cannot skip to version 3', () => publish('admin', 3));
    await denied('admin cannot republish version 1 again', () => publish('admin', 1));
    await denied('a plain update by another user is denied', () => updateDoc(formRef('other'), { version: 2 }));
    await ok('admin publishes version 2', () => publish('admin', 2));
    await ok('admin publishes version 3', () => publish('admin', 3));
    await denied('admin cannot go back to version 2', () => publish('admin', 2));

    // shape
    await denied('doc id must be {season}_{formType}', () => publish('admin', 1, {}, '2099_wrongType'));
    await denied('formType must be pitScouting or matchScouting', () => publish('admin', 1, { formType: 'otherScouting' }, '2098_otherScouting'));
    await denied('season must be 20xx', () => publish('admin', 1, { season: '99' }, '99_pitScouting'));
    await denied('fields must not be empty', () => publish('admin', 1, { fields: [] }, '2097_pitScouting'));
    await denied('fields must be a list', () => publish('admin', 1, { fields: 'nope' }, '2097_pitScouting'));
    await denied('more than 100 fields is refused', () => publish('admin', 1, { fields: Array.from({ length: 101 }, (_, i) => field(`f${i}`)) }, '2097_pitScouting'));
    await denied('publishedBy must be the caller', () => publish('admin', 1, { publishedBy: uid.other }, '2097_pitScouting'));
    await denied('publishedAt must be the server time', () => publish('admin', 1, { publishedAt: new Date(0) }, '2097_pitScouting'));
    await denied('an unexpected extra field is refused', () => publish('admin', 1, { notes: 'x' }, '2097_pitScouting'));
    await ok('match forms are versioned separately (own doc, own version 1)', () => publish('admin', 1, { formType: 'matchScouting' }, `${season}_matchScouting`));
    await ok('publishing pit again does not touch match (match is still at 1)', async () => {
      const snap = await getDoc(formRef('admin', `${season}_matchScouting`));
      if (snap.data().version !== 1) throw new Error('match version moved');
    });

    // history integrity
    await denied('a history copy cannot be written without the parent moving to that version', () => setDoc(versionRef('admin', 9), form('admin', 9)));
    await denied('history doc id must be the version number', async () => {
      const batch = writeBatch(fs.admin);
      batch.set(formRef('admin'), form('admin', 4));
      batch.set(doc(fs.admin, 'officialForms', formId, 'versions', 'x'), form('admin', 4));
      await batch.commit();
    });
    await denied('a history copy must match the parent version', async () => {
      const batch = writeBatch(fs.admin);
      batch.set(formRef('admin'), form('admin', 4));
      batch.set(versionRef('admin', 5), form('admin', 5));
      await batch.commit();
    });
    await denied('history is immutable (no update, even by the admin)', () => updateDoc(versionRef('admin', 1), { fields: [field('changed')] }));
    await denied('another user cannot delete a history copy', () => deleteDoc(versionRef('other', 1)));

    // delete
    await denied('another user cannot delete an official form', () => deleteDoc(formRef('other')));
    await denied('the unverified admin address cannot delete one', () => deleteDoc(formRef('adminUnverified')));
    await ok('the verified admin can delete an official form (console-style cleanup)', () => deleteDoc(formRef('admin', `${season}_matchScouting`)));
    await denied('republishing version 1 collides with the surviving history copy (deleting a form leaves its history)', () => publish('admin', 1, { formType: 'matchScouting' }, `${season}_matchScouting`));
    await ok('the verified admin can delete the history copy too', () => deleteDoc(versionRef('admin', 1, `${season}_matchScouting`)));
    await ok('after deleting the form AND its history, the first publish is version 1 again', () => publish('admin', 1, { formType: 'matchScouting' }, `${season}_matchScouting`));

    // ---------- formSnapshots ----------
    const snapRef = (who, id) => doc(fs[who], 'teams', teamId, 'formSnapshots', id);
    const snapshot = (who, extra = {}) => ({
      season: '2025', formType: 'pitScouting', formKey: '2025_pitScouting', fields: [field('notes')],
      retiredFields: [], baseVersion: null, handledVersion: 0, appliedVersion: 3, action: 'accept',
      createdAt: serverTimestamp(), createdBy: uid[who], createdByName: who, ...extra
    });
    await ok('captain can save a snapshot', () => setDoc(snapRef('cap', 's1'), snapshot('cap')));
    await ok('a member with canEditTemplates can save a snapshot', () => setDoc(snapRef('forms', 's2'), snapshot('forms', { action: 'merge', baseVersion: 2 })));
    await denied('a plain member cannot save a snapshot', () => setDoc(snapRef('mem', 's3'), snapshot('mem')));
    await denied('a non-member cannot save a snapshot', () => setDoc(snapRef('out', 's4'), snapshot('out')));
    await denied('snapshot createdBy must be the caller', () => setDoc(snapRef('cap', 's5'), snapshot('cap', { createdBy: uid.forms })));
    await denied('snapshot createdAt must be the server time', () => setDoc(snapRef('cap', 's6'), snapshot('cap', { createdAt: new Date(0) })));
    await denied('snapshot formKey must match season + formType', () => setDoc(snapRef('cap', 's7'), snapshot('cap', { formKey: '2025_matchScouting' })));
    await denied('snapshot action must be accept / merge / restore', () => setDoc(snapRef('cap', 's8'), snapshot('cap', { action: 'delete' })));
    await denied('snapshot with an unexpected field is refused', () => setDoc(snapRef('cap', 's9'), snapshot('cap', { extra: 1 })));
    await denied('snapshot fields must be a list', () => setDoc(snapRef('cap', 's10'), snapshot('cap', { fields: 'x' })));
    await ok('captain can read snapshots', () => getDoc(snapRef('cap', 's1')));
    await ok('a forms editor can read snapshots', () => getDoc(snapRef('forms', 's1')));
    await denied('a plain member cannot read snapshots', () => getDoc(snapRef('mem', 's1')));
    await denied('a non-member cannot read snapshots', () => getDoc(snapRef('out', 's1')));
    await denied('snapshots are create-once (no update, even by the captain)', () => updateDoc(snapRef('cap', 's1'), { action: 'merge' }));
    await denied('a plain member cannot delete a snapshot', () => deleteDoc(snapRef('mem', 's1')));
    await ok('a forms editor can delete (prune) a snapshot', () => deleteDoc(snapRef('forms', 's2')));
    await ok('captain can delete a snapshot', () => deleteDoc(snapRef('cap', 's1')));
    await env.withSecurityRulesDisabled(async (c) => {
      await setDoc(doc(c.firestore(), 'teams', soloTeamId, 'formSnapshots', 'x1'), { season: '2025', formType: 'pitScouting', formKey: '2025_pitScouting', fields: [], action: 'accept', createdAt: new Date(), createdBy: 'z' });
    });
    await ok('the last member of a team can delete its snapshots (team deletion)', () => deleteDoc(doc(fs.solo, 'teams', soloTeamId, 'formSnapshots', 'x1')));

    // ---------- formConfig version fields ----------
    const cfgRef = (who, id) => doc(fs[who], 'teams', teamId, 'formConfig', id);
    await ok('captain: legacy shape {fields} still saves', () => setDoc(cfgRef('cap', '2025_pitScouting'), { fields: [field('notes')] }));
    await ok('captain: full versioned config saves', () => setDoc(cfgRef('cap', '2025_matchScouting'), { fields: [field('notes')], baseVersion: 3, handledVersion: 3, retiredFields: [field('old')] }));
    await ok('baseVersion may be null ("never accepted")', () => setDoc(cfgRef('cap', '2024_pitScouting'), { fields: [field('notes')], baseVersion: null, handledVersion: 2 }));
    await ok('a forms editor can bump handledVersion alone (Keep my form)', () => updateDoc(cfgRef('forms', '2025_matchScouting'), { handledVersion: 4 }));
    await denied('a plain member cannot change a config', () => updateDoc(cfgRef('mem', '2025_matchScouting'), { handledVersion: 9 }));
    await denied('handledVersion must be an integer', () => updateDoc(cfgRef('cap', '2025_matchScouting'), { handledVersion: '4' }));
    await denied('handledVersion cannot be negative', () => updateDoc(cfgRef('cap', '2025_matchScouting'), { handledVersion: -1 }));
    await denied('baseVersion must be an integer or null', () => updateDoc(cfgRef('cap', '2025_matchScouting'), { baseVersion: 'two' }));
    await denied('retiredFields must be a list', () => updateDoc(cfgRef('cap', '2025_matchScouting'), { retiredFields: 'x' }));
    await denied('retiredFields is capped (201 entries refused)', () => updateDoc(cfgRef('cap', '2025_matchScouting'), { retiredFields: Array.from({ length: 201 }, (_, i) => field(`r${i}`)) }));

    if (failures.length > 0) throw new Error(`${failures.length} rule check(s) failed (${passed} passed):\n  ${failures.join('\n  ')}`);
    ctx.log(`${passed} checks`);
  }
};
