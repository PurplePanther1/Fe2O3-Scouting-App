// ====== Delete Account ======
// Full sequence: reauthenticate → anonymize the departing user's own
// attribution on their team's pit/match scouting entries → self-leave the
// team (members/roles/permissions, via the rules' self-leave branch) →
// delete userTeams/{uid} → delete users/{uid}/private/contact →
// delete users/{uid} → delete the Firebase Auth account itself.
//
// A captain is blocked from this entirely while other members remain on the
// team — they must transfer captaincy first (My Team tab) — matching the
// rules' self-leave branch, which only allows a captain to use it when
// members.size() == 1.

// ====== Open the modal — shows the captain-block message instead of the
// form when that applies ======
function openDeleteAccountModal() {
  if (!currentUser) return;

  const blockedEl = document.getElementById('delete-account-blocked');
  const formEl = document.getElementById('delete-account-form');
  const errorEl = document.getElementById('delete-account-error');
  const successEl = document.getElementById('delete-account-success');
  const passwordInput = document.getElementById('input-delete-account-password');

  errorEl.textContent = '';
  successEl.textContent = '';
  if (passwordInput) passwordInput.value = '';

  const isCaptain = typeof getCurrentUserRole === 'function' && getCurrentUserRole() === 'captain';
  const otherMembersExist = !!(currentTeamData && Array.isArray(currentTeamData.members) && currentTeamData.members.length > 1);

  if (isCaptain && otherMembersExist) {
    blockedEl.classList.remove('hidden');
    formEl.classList.add('hidden');
  } else {
    blockedEl.classList.add('hidden');
    formEl.classList.remove('hidden');

    const hasPasswordProvider = !!(currentUser.providerData &&
      currentUser.providerData.some(p => p.providerId === 'password'));
    document.getElementById('delete-account-password-field').classList.toggle('hidden', !hasPasswordProvider);
    document.getElementById('delete-account-google-note').classList.toggle('hidden', hasPasswordProvider);
  }

  document.getElementById('delete-account-modal').classList.remove('hidden');
}

function closeDeleteAccountModal() {
  document.getElementById('delete-account-modal').classList.add('hidden');
}

// ====== Anonymize this user's own attribution on their team's scouting
// entries — scoutedByName wherever they're the original scouter, and
// lastEditedByName wherever they were the last editor of any entry (which
// may belong to someone else). scoutedBy/lastEditedBy (the uid) and all
// other entry data are left untouched. Best-effort: a failure on one
// document (e.g. a permission that changed since an old edit) is logged and
// skipped rather than aborting the rest. ======
async function anonymizeOwnScoutingEntries(teamId, uid) {
  const collections = ['pitScouting', 'matchScouting'];
  const fieldPairs = [
    { queryField: 'scoutedBy', nameField: 'scoutedByName' },
    { queryField: 'lastEditedBy', nameField: 'lastEditedByName' }
  ];

  for (const collectionName of collections) {
    for (const { queryField, nameField } of fieldPairs) {
      try {
        // teamId is included alongside the uid filter for the same reason the
        // Sheets export queries do — Firestore can only validate a list query
        // against a rule that does get(resource.data.teamId) when teamId is
        // pinned to a single value by an exact-match where() clause.
        const snap = await db.collection(collectionName)
          .where('teamId', '==', teamId)
          .where(queryField, '==', uid)
          .get();

        const refs = [];
        snap.forEach(doc => refs.push(doc.ref));

        for (const ref of refs) {
          try {
            await ref.update({ [nameField]: 'Deleted User' });
          } catch (err) {
            console.warn(`Failed to anonymize ${nameField} on ${collectionName}/${ref.id}:`, err);
          }
        }
      } catch (err) {
        console.warn(`Failed to query ${collectionName} by ${queryField} for anonymization:`, err);
      }
    }
  }
}

// ====== Remove the current user from a team's members/roles/permissions —
// the self-leave branch on teams/{teamId}'s update rule. Shared by Delete
// Account and the My Team tab's "Leave Team" button. ======
async function selfLeaveTeam(teamId, uid) {
  const updates = {
    members: firebase.firestore.FieldValue.arrayRemove(uid)
  };
  updates[`roles.${uid}`] = firebase.firestore.FieldValue.delete();
  updates[`permissions.${uid}`] = firebase.firestore.FieldValue.delete();
  await db.collection('teams').doc(teamId).update(updates);
}

async function confirmDeleteAccount() {
  const errorEl = document.getElementById('delete-account-error');
  const successEl = document.getElementById('delete-account-success');
  errorEl.textContent = '';
  successEl.textContent = '';

  if (!currentUser) {
    errorEl.textContent = 'You must be signed in to delete your account.';
    return;
  }

  if (!confirm('This will permanently delete your account. This cannot be undone. Continue?')) {
    return;
  }

  const hasPasswordProvider = !!(currentUser.providerData &&
    currentUser.providerData.some(p => p.providerId === 'password'));

  // Reauth first, before any Firestore mutation, so a cancelled/failed reauth
  // leaves nothing half-changed.
  showLoading('Verifying your identity...');
  try {
    if (hasPasswordProvider) {
      const currentPassword = document.getElementById('input-delete-account-password').value;
      if (!currentPassword) {
        hideLoading();
        errorEl.textContent = 'Please enter your current password.';
        return;
      }
      const cred = firebase.auth.EmailAuthProvider.credential(currentUser.email, currentPassword);
      await currentUser.reauthenticateWithCredential(cred);
    } else {
      // Google-only accounts have no password — reauthenticate with the same
      // provider/popup flow used for Google sign-in.
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      await currentUser.reauthenticateWithPopup(provider);
    }
  } catch (err) {
    hideLoading();
    console.error('Delete account reauth error:', err);
    if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/popup-blocked') {
      errorEl.textContent = friendlyAuthError(err.code);
    } else if (hasPasswordProvider) {
      errorEl.textContent = 'Incorrect password. Please try again.';
    } else {
      errorEl.textContent = 'Could not verify your identity. Please try again.';
    }
    return;
  }

  const uid = currentUser.uid;
  const teamId = currentTeamData?.id || null;

  // Stop listeners tied to team/event membership before we start removing
  // that membership — otherwise they'll harmlessly error out mid-sequence
  // once read access is gone.
  if (typeof watchTeamDoc === 'function') watchTeamDoc(null);
  if (typeof watchPitScoutStatus === 'function') watchPitScoutStatus(null);
  if (typeof watchMatchScoutStatus === 'function') watchMatchScoutStatus(null);

  try {
    if (teamId) {
      showLoading('Cleaning up your scouting data...');
      await anonymizeOwnScoutingEntries(teamId, uid);

      showLoading('Removing you from your team...');
      // Labeled via withStep() (same helper sheets-export.js uses) so any
      // failure here is identifiable by step rather than a bare "Missing or
      // insufficient permissions" with no indication of which write it was.
      await withStep('Leaving team (self-leave write)', () => selfLeaveTeam(teamId, uid));
    }

    showLoading('Deleting your account data...');
    await withStep('Deleting userTeams pointer', () => db.collection('userTeams').doc(uid).delete());
    await withStep('Deleting private contact doc', () => db.collection('users').doc(uid).collection('private').doc('contact').delete());
    await withStep('Deleting user profile doc', () => db.collection('users').doc(uid).delete());

    showLoading('Deleting your account...');
    await withStep('Deleting Firebase Auth account', () => currentUser.delete());

    hideLoading();

    // Close and clean up immediately rather than on a delay — currentUser.delete()
    // already ends the Firebase session, which fires the app's own
    // onAuthStateChanged listener right away. A delay here just left the modal
    // visibly lingering after that listener had already flipped the screen
    // underneath it, and let our own cleanup below fire late enough to race
    // whatever the user did next (e.g. signing into a brand new account).
    closeDeleteAccountModal();
    // Reuses the same sign-out cleanup (auth form fields, selected
    // event/team state, session storage) rather than duplicating it —
    // currentUser.delete() already ends the Firebase session itself.
    if (typeof signOut === 'function') {
      await signOut();
    } else {
      showScreen('screen-login');
    }
  } catch (err) {
    hideLoading();
    console.error('Delete account error:', err);
    // friendlyAuthError() already falls back to a generic message for
    // non-auth errors (e.g. a Firestore permission-denied), since its map
    // lookup just misses and returns the default.
    errorEl.textContent = friendlyAuthError(err.code);
  }
}

document.getElementById('btn-open-delete-account').addEventListener('click', openDeleteAccountModal);
document.getElementById('btn-delete-account-close').addEventListener('click', closeDeleteAccountModal);
document.getElementById('btn-delete-account-cancel').addEventListener('click', closeDeleteAccountModal);
document.getElementById('delete-account-modal-overlay').addEventListener('click', closeDeleteAccountModal);
document.getElementById('btn-delete-account-confirm').addEventListener('click', confirmDeleteAccount);
