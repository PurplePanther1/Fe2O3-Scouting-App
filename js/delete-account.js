// ====== Delete Account ======
// Full sequence: reauthenticate → for EVERY team the account belongs to
// (multi-team support): if they're the team's LAST member, delete the whole
// team (deleteEntireTeam() — its data doesn't survive them); otherwise
// anonymize the departing user's own attribution on that team's pit/match
// scouting entries, then self-leave it (members/roles/permissions + that
// team's memberContacts/{uid} copy, via the rules' self-leave branch) →
// delete users/{uid}/private/contact → delete users/{uid} → delete the
// Firebase Auth account itself.
//
// Blocked entirely if the user is captain of ANY team (not just the active
// one) with other members remaining on it — they must transfer captaincy
// there first (My Team tab) — matching the rules' self-leave branch, which
// only allows a captain to use it when members.size() == 1. This must be an
// all-or-nothing check across every team: allowing the deletion to proceed
// for teams where they're not blocked would leave them account-deleted while
// still stranded as captain of whichever team WAS blocking, with no one able
// to ever remove or transfer them again.

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

  // Check EVERY team the user belongs to, not just the active one — deleting
  // the account must not strand a team the user happens to be captain of
  // (but isn't currently viewing) without anyone who can transfer captaincy,
  // since a captain can only self-leave via this same rule when they're the
  // team's last member.
  const teamsToCheck = (typeof myTeams !== 'undefined' && Array.isArray(myTeams) && myTeams.length > 0)
    ? myTeams
    : (currentTeamData ? [currentTeamData] : []);
  const blockingTeams = teamsToCheck.filter(t =>
    t && t.roles && t.roles[currentUser.uid] === 'captain'
    && Array.isArray(t.members) && t.members.length > 1
  );

  if (blockingTeams.length > 0) {
    const blockedMessageEl = document.getElementById('delete-account-blocked-message');
    if (blockedMessageEl) {
      const names = blockingTeams.map(t => t.name || 'Unnamed team').join(', ');
      blockedMessageEl.textContent = blockingTeams.length === 1
        ? `You're the captain of "${names}", and other members are still on it. Please transfer the captain role to another member before deleting your account.`
        : `You're the captain of these teams, and other members are still on them: ${names}. Please transfer the captain role for each one before deleting your account.`;
    }

    // One button per blocking team, including the currently active one — same
    // uniform label for every button regardless of whether that team happens
    // to be active right now (isActive only changes what the click does: the
    // active team just needs the tab switch, since switchActiveTeam() isn't
    // needed/possible for the team already active; every other team also
    // switches teams first).
    const blockedActionsEl = document.getElementById('delete-account-blocked-actions');
    if (blockedActionsEl) {
      blockedActionsEl.innerHTML = '';
      blockingTeams.forEach(t => {
        const isActive = t.id === currentTeamId;
        const teamName = t.name || 'Unnamed team';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-small btn-outline';
        btn.style.cssText = 'margin-top:8px; margin-right:8px;';
        btn.textContent = `Switch to "${teamName}'s" "My Team" tab to transfer`;
        btn.addEventListener('click', () => {
          closeDeleteAccountModal();
          if (isActive) {
            // switchActiveTeam() already lands on the My Team tab itself —
            // no switch needed here since we're already on this team.
            if (typeof activateDashboardTab === 'function') activateDashboardTab('myteam');
          } else if (typeof switchActiveTeam === 'function') {
            switchActiveTeam(t.id);
          }
        });
        blockedActionsEl.appendChild(btn);
      });
    }

    blockedEl.classList.remove('hidden');
    formEl.classList.add('hidden');
  } else {
    blockedEl.classList.add('hidden');
    formEl.classList.remove('hidden');

    // Not blocked, but may still be the SOLE member of one or more teams —
    // deleting the account will delete those teams entirely (see
    // deleteEntireTeam()), not just remove their own membership. A heads-up,
    // not a block: nothing prevents them from proceeding.
    const soleOwnerWarningEl = document.getElementById('delete-account-sole-owner-warning');
    const soleOwnerTeams = teamsToCheck.filter(t => t && Array.isArray(t.members) && t.members.length === 1);
    // The one case where the main paragraph and the box below used to say
    // almost the same thing twice, back to back — exactly one team total,
    // and it's the sole-owned one. Every other combination keeps two
    // paragraphs on purpose: with multiple sole-owned teams the box adds the
    // actual names the main paragraph doesn't list, and in the mixed case
    // (some shared, some sole-owned) each paragraph is a true statement about
    // a different team, not a restatement of the same one.
    const isSingleSoleTeam = teamsToCheck.length === 1 && soleOwnerTeams.length === 1;

    // The main paragraph's "entries remain, credited to Deleted User" claim is
    // only true for teams the user shares with others (anonymizeOwnScoutingEntries()
    // + selfLeaveTeam()) — for a team they're the sole member of, deleteEntireTeam()
    // wipes that team's data entirely instead, same condition the sole-owner
    // warning below already checks.
    const mainWarningEl = document.getElementById('delete-account-main-warning');
    if (mainWarningEl) {
      if (soleOwnerTeams.length === 0) {
        mainWarningEl.textContent = 'This permanently deletes your account and cannot be undone. Your existing scouting entries will remain, credited to "Deleted User" instead of your name — but you\'ll be removed from your team and signed out.';
      } else if (isSingleSoleTeam) {
        // Kept deliberately short — the combined message (account + team +
        // data + export reminder) lives in the sole-owner box below instead,
        // styled after the Leave Team modal's equivalent single-message case.
        mainWarningEl.textContent = 'This permanently deletes your account and cannot be undone.';
      } else if (soleOwnerTeams.length === teamsToCheck.length) {
        mainWarningEl.textContent = 'This permanently deletes your account and cannot be undone. Since you\'re the only member of every team you belong to, ALL of their data — including every scouting entry — will be permanently deleted along with them, not anonymized or kept.';
      } else {
        mainWarningEl.textContent = 'This permanently deletes your account and cannot be undone. For teams you share with others, your existing scouting entries will remain, credited to "Deleted User" instead of your name. For team(s) you\'re the only member of (see below), ALL of that team\'s data — including every scouting entry — is permanently deleted instead. You\'ll be removed from your team(s) and signed out.';
      }
    }

    if (soleOwnerWarningEl) {
      if (isSingleSoleTeam) {
        const name = soleOwnerTeams[0].name || 'Unnamed team';
        soleOwnerWarningEl.textContent = `Since you're the last member of "${name}", deleting your account will also permanently delete the ENTIRE team and all its data. Export it first if you want to keep a copy.`;
        soleOwnerWarningEl.classList.remove('hidden');
      } else if (soleOwnerTeams.length > 0) {
        const names = soleOwnerTeams.map(t => t.name || 'Unnamed team').join(', ');
        soleOwnerWarningEl.textContent = soleOwnerTeams.length === 1
          ? `You're the only member of "${names}" — deleting your account will permanently delete this ENTIRE team and all its scouting data, not just your own membership.`
          : `You're the only member of these teams: ${names}. Deleting your account will permanently delete these ENTIRE teams and all their scouting data, not just your own membership.`;
        soleOwnerWarningEl.classList.remove('hidden');
      } else {
        soleOwnerWarningEl.classList.add('hidden');
      }
    }

    // One "Export Whole Team Data" button + status line per sole-owner team —
    // lets the user export each team's FULL scouting history (every event,
    // via openWholeTeamExportChoice(), sheets-export.js) before that account
    // deletion permanently destroys it. Rebuilt fresh every time the modal
    // opens, same as delete-account-blocked-actions above.
    const exportActionsEl = document.getElementById('delete-account-export-actions');
    if (exportActionsEl) {
      exportActionsEl.innerHTML = '';
      soleOwnerTeams.forEach(t => {
        const statusPrefix = `delete-account-export-${t.id}`;
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'margin-bottom:10px;';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-small btn-outline';
        btn.style.cssText = 'width:100%;';
        btn.textContent = `📦 Export "${t.name || 'Unnamed team'}" Whole Team Data`;
        btn.addEventListener('click', () => {
          if (typeof openWholeTeamExportChoice === 'function') {
            openWholeTeamExportChoice(t.id, t.name, statusPrefix);
          }
        });

        const errorEl = document.createElement('p');
        errorEl.className = 'error-message';
        errorEl.id = `${statusPrefix}-error`;
        const successEl = document.createElement('p');
        successEl.className = 'success-message';
        successEl.id = `${statusPrefix}-success`;

        wrapper.appendChild(btn);
        wrapper.appendChild(errorEl);
        wrapper.appendChild(successEl);
        exportActionsEl.appendChild(wrapper);
      });
    }

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
  const fieldPairs = [
    { queryField: 'scoutedBy', nameField: 'scoutedByName' },
    { queryField: 'lastEditedBy', nameField: 'lastEditedByName' }
  ];

  // Both pitScouting and matchScouting are now teams/{teamId}/pitScouting
  // and teams/{teamId}/matchScouting subcollections, scoped by path — no
  // teamId where() clause needed on either.
  const collections = [
    { name: 'pitScouting', baseQuery: db.collection('teams').doc(teamId).collection('pitScouting') },
    { name: 'matchScouting', baseQuery: db.collection('teams').doc(teamId).collection('matchScouting') }
  ];

  for (const { name, baseQuery } of collections) {
    for (const { queryField, nameField } of fieldPairs) {
      try {
        const snap = await baseQuery.where(queryField, '==', uid).get();

        const refs = [];
        snap.forEach(doc => refs.push(doc.ref));

        for (const ref of refs) {
          try {
            await ref.update({ [nameField]: 'Deleted User' });
          } catch (err) {
            console.warn(`Failed to anonymize ${nameField} on ${name}/${ref.id}:`, err);
          }
        }
      } catch (err) {
        console.warn(`Failed to query ${name} by ${queryField} for anonymization:`, err);
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

  // This team's saved event/search state (session-state.js) shouldn't
  // outlive this person's membership — rejoining later (same teamId, since
  // leaving doesn't delete/recreate the team doc) should be a fresh start,
  // not a restore of whatever was active before they left.
  if (typeof clearTeamSessionState === 'function') {
    clearTeamSessionState(teamId);
  }

  // Clean up this team's copy of the departing user's email alongside their
  // membership — teams/{teamId}/memberContacts/{uid} only exists so this
  // team's captain/permitted teammates can see it, and shouldn't outlive
  // this person's membership on it.
  try {
    await db.collection('teams').doc(teamId).collection('memberContacts').doc(uid).delete();
  } catch (err) {
    console.warn(`Failed to delete memberContacts for team ${teamId}:`, err);
  }

  // Same reasoning as memberContacts above — this team's copy of the
  // departing user's per-team display name shouldn't outlive their membership.
  try {
    await db.collection('teams').doc(teamId).collection('memberDisplayNames').doc(uid).delete();
  } catch (err) {
    console.warn(`Failed to delete memberDisplayNames for team ${teamId}:`, err);
  }
}

// ====== Delete every pitScouting/matchScouting entry for a team — used when
// the WHOLE team is being deleted (last member leaving), not just anonymized
// like anonymizeOwnScoutingEntries() does for a team that carries on without
// them. Best-effort per document, same style: a failure on one entry is
// logged and skipped rather than aborting the rest. ======
async function deleteAllScoutingEntriesForTeam(teamId) {
  // Both are teams/{teamId}/pitScouting and teams/{teamId}/matchScouting
  // subcollections now, scoped by path.
  const collections = [
    { name: 'pitScouting', query: db.collection('teams').doc(teamId).collection('pitScouting') },
    { name: 'matchScouting', query: db.collection('teams').doc(teamId).collection('matchScouting') }
  ];

  for (const { name, query } of collections) {
    try {
      const snap = await query.get();
      for (const doc of snap.docs) {
        try {
          await doc.ref.delete();
        } catch (err) {
          console.warn(`Failed to delete ${name}/${doc.id}:`, err);
        }
      }
    } catch (err) {
      console.warn(`Failed to query ${name} for team deletion:`, err);
    }
  }
}

// ====== Delete an entire team — used instead of anonymize+self-leave when
// the departing member is the team's LAST one (firestore.rules gates the
// team doc/formConfig/joinCodes delete rules on members.size() == 1, exactly
// this case). Order matters: entries, formConfig, joinCodes, and
// memberContacts are all deleted BEFORE the team doc itself, because
// canEditOrDeleteEntry()/canEditTemplates() depend on the team doc still
// existing with this user's captain role intact in `roles` — delete the team
// doc first and every one of those deletes would be denied afterward.
// Shared by Delete Account and the My Team tab's "Leave Team" button, same
// as selfLeaveTeam(). ======
async function deleteEntireTeam(teamId, uid, teamData) {
  await deleteAllScoutingEntriesForTeam(teamId);

  // Tidiness, not correctness — this teamId can never be rejoined once the
  // team doc itself is gone (below), but there's no reason to leave its
  // saved event/search state (session-state.js) orphaned in sessionStorage.
  if (typeof clearTeamSessionState === 'function') {
    clearTeamSessionState(teamId);
  }

  // formConfig now holds one doc per season per form type
  // ({season}_pitScouting/{season}_matchScouting — dynamic-form.js), plus
  // possibly the old pre-season-scoping shared docs (pitScouting/
  // matchScouting) for a team that hasn't triggered migration yet — so the
  // whole subcollection has to be queried and cleared, not just those two
  // legacy doc IDs, or every other season's saved config would be orphaned.
  // Same best-effort per-document style as deleteAllScoutingEntriesForTeam() above.
  try {
    const formConfigSnap = await db.collection('teams').doc(teamId).collection('formConfig').get();
    for (const doc of formConfigSnap.docs) {
      try {
        await doc.ref.delete();
      } catch (err) {
        console.warn(`Failed to delete formConfig/${doc.id} for team ${teamId}:`, err);
      }
    }
  } catch (err) {
    console.warn(`Failed to query formConfig for team deletion:`, err);
  }

  // Scrimmage docs (their entries were already removed by
  // deleteAllScoutingEntriesForTeam() above, which is unfiltered by event).
  // Like formConfig, they must go BEFORE the team doc: the captain's
  // canManageScrimmages() rule check reads it.
  try {
    const scrimmagesSnap = await db.collection('teams').doc(teamId).collection('scrimmages').get();
    for (const doc of scrimmagesSnap.docs) {
      try {
        await doc.ref.delete();
      } catch (err) {
        console.warn(`Failed to delete scrimmages/${doc.id} for team ${teamId}:`, err);
      }
    }
  } catch (err) {
    console.warn('Failed to query scrimmages for team deletion:', err);
  }

  if (teamData && teamData.joinCode) {
    try {
      await db.collection('joinCodes').doc(teamData.joinCode).delete();
    } catch (err) {
      console.warn(`Failed to delete joinCodes entry for team ${teamId}:`, err);
    }
  }

  try {
    await db.collection('teams').doc(teamId).collection('memberContacts').doc(uid).delete();
  } catch (err) {
    console.warn(`Failed to delete memberContacts for team ${teamId}:`, err);
  }

  try {
    await db.collection('teams').doc(teamId).collection('memberDisplayNames').doc(uid).delete();
  } catch (err) {
    console.warn(`Failed to delete memberDisplayNames for team ${teamId}:`, err);
  }

  // Must be last — everything above depends on this document (and this
  // user's captain role within it) still existing. Deliberately not wrapped
  // in try/catch here, same as selfLeaveTeam()'s team-doc update: a failure
  // here is the operation failing, and should propagate to the caller's
  // withStep() wrapper rather than being silently swallowed.
  await db.collection('teams').doc(teamId).delete();
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

  const hasPasswordProvider = !!(currentUser.providerData &&
    currentUser.providerData.some(p => p.providerId === 'password'));

  // Reauth FIRST, before showing the "are you sure" confirmation below — a
  // wrong password (or a cancelled/failed Google popup) now fails right
  // here, immediately, instead of only surfacing after the user has already
  // clicked through a confirmation for a deletion that a bad credential was
  // never going to allow anyway.
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
  hideLoading();

  if (typeof showConfirmModal !== 'function') return;
  // Stacks above delete-account-modal (see #generic-confirm-modal's z-index
  // in style.css) rather than closing it first — same nested-modal pattern
  // as the export-choice modal opening on top of Leave Team's confirmation.
  // Reauth already succeeded by this point, so onConfirm below goes
  // straight into the actual deletion — no credentials left to check.
  showConfirmModal({
    title: 'Delete Account?',
    message: 'This will permanently delete your account. This cannot be undone. Continue?',
    confirmLabel: 'Delete Account',
    danger: true,
    onConfirm: async () => {
      const uid = currentUser.uid;
      // Every team this account belongs to, not just the active one — deleting
      // the account has to clean up all of them, or it'd leave the departed
      // user's uid stuck in every OTHER team's members/roles/permissions and
      // memberContacts forever (no one can ever remove them after this point —
      // only the account itself could self-leave, and it's about to stop existing).
      const teams = (typeof myTeams !== 'undefined' && Array.isArray(myTeams) && myTeams.length > 0)
        ? myTeams.slice()
        : (currentTeamData ? [currentTeamData] : []);

      // Stop listeners tied to team/event membership before we start removing
      // that membership — otherwise they'll harmlessly error out mid-sequence
      // once read access is gone.
      if (typeof watchTeamDoc === 'function') watchTeamDoc(null);
      if (typeof watchPitScoutStatus === 'function') watchPitScoutStatus(null);
      if (typeof watchMatchScoutStatus === 'function') watchMatchScoutStatus(null);

      try {
        for (const team of teams) {
          const teamLabel = team.name || team.id;
          const isSoleMember = Array.isArray(team.members) && team.members.length === 1;

          // watchMyTeams() (auth.js) still has a live per-team listener on
          // EVERY one of these teams at this point — only the active team's
          // watchTeamDoc() listener was stopped above. Without marking each
          // one as an expected self-removal first, the membership-removing
          // write below (deleteEntireTeam() or selfLeaveTeam()) can trigger
          // that listener's permission-denied path and pop a bogus "Removed
          // from Team" notice mid-deletion — this is a deliberate,
          // self-initiated action, same category as an ordinary Leave Team,
          // not a surprise removal. Same fix as performLeaveTeam() (members.js).
          if (typeof markExpectedSelfRemoval === 'function') markExpectedSelfRemoval(team.id);

          if (isSoleMember) {
            // Last member — the whole team (and its data) goes with them, not
            // just their own membership. See deleteEntireTeam() for why order
            // matters here.
            showLoading(teams.length > 1 ? `Deleting team ${teamLabel} and all its data...` : 'Deleting your team and all its data...');
            await withStep(`Deleting team ${teamLabel}`, () => deleteEntireTeam(team.id, uid, team));
            continue;
          }

          showLoading(teams.length > 1 ? `Cleaning up your scouting data (${teamLabel})...` : 'Cleaning up your scouting data...');
          await anonymizeOwnScoutingEntries(team.id, uid);

          showLoading(teams.length > 1 ? `Removing you from ${teamLabel}...` : 'Removing you from your team...');
          // Labeled via withStep() (same helper sheets-export.js uses) so any
          // failure here is identifiable by step (and by team) rather than a
          // bare "Missing or insufficient permissions".
          await withStep(`Leaving team ${teamLabel} (self-leave write)`, () => selfLeaveTeam(team.id, uid));
        }

        showLoading('Deleting your account data...');
        await withStep('Deleting activity log', () => deleteActivityLogSubcollection(uid));
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
  });
}

document.getElementById('btn-open-delete-account').addEventListener('click', openDeleteAccountModal);
document.getElementById('btn-delete-account-close').addEventListener('click', closeDeleteAccountModal);
document.getElementById('btn-delete-account-cancel').addEventListener('click', closeDeleteAccountModal);
document.getElementById('delete-account-modal-overlay').addEventListener('click', closeDeleteAccountModal);
document.getElementById('btn-delete-account-confirm').addEventListener('click', confirmDeleteAccount);
