// ====== My Team Tab: Member List & Captain Management ======

let currentTeamId = null;
let currentTeamRoles = {};
let currentTeamPermissions = {};

// ====== Dashboard tab switching ======
// Exposed globally so a fresh login can reset to the default tab (Scouting)
// the same way a page refresh does, instead of duplicating this logic.
function activateDashboardTab(name) {
  document.querySelectorAll('#dashboard-tabs .tab').forEach(t => {
    t.classList.toggle('active', t.dataset.dtab === name);
  });
  document.querySelectorAll('.dtab-content').forEach(tc => tc.classList.remove('active'));
  const content = document.getElementById('dtab-' + name);
  if (content) content.classList.add('active');

  if (typeof saveSessionState === 'function') {
    saveSessionState();
  }
}
window.activateDashboardTab = activateDashboardTab;

document.querySelectorAll('#dashboard-tabs .tab').forEach(tab => {
  tab.addEventListener('click', () => {
    activateDashboardTab(tab.dataset.dtab);
  });
});

// ====== Setup My Team copy button ======
setupCopyButton('btn-copy-myteam-code', 'myteam-join-code-value');

// ====== Load and display team members ======
// Resolves every member's display info up front (in parallel) before
// rendering anything, so the list appears once with real names/emails
// instead of flashing "Loading..." and raw uids per row while each fetch
// trickles in — only the "Loading members..." status text covers the wait.
async function loadTeamMembers(teamId, teamData) {
  currentTeamId = teamId;
  currentTeamRoles = teamData.roles || {};
  currentTeamPermissions = teamData.permissions || {};

  // Show join code
  const joinCodeEl = document.getElementById('myteam-join-code-value');
  if (joinCodeEl && teamData.joinCode) {
    joinCodeEl.textContent = teamData.joinCode;
  }

  const memberList = document.getElementById('member-list');
  const status = document.getElementById('member-list-status');

  if (!teamData.members || teamData.members.length === 0) {
    memberList.innerHTML = '';
    status.textContent = 'No members found.';
    return;
  }

  // Only show the "Loading members..." flash (and blank the list) on a
  // genuine first load. A refresh triggered by the live team-doc listener —
  // e.g. right after saving a permission change — re-runs this whole
  // function, but the existing rows should stay visible while the new data
  // fetches, then get swapped in once ready, instead of blanking to a
  // loading state the user just watched load a moment ago.
  const isFirstLoad = memberList.children.length === 0;
  if (isFirstLoad) {
    status.textContent = 'Loading members...';
  }

  // Populate the display-name input with whatever this user has already chosen
  const nameInput = document.getElementById('input-display-name');
  if (nameInput) {
    nameInput.value = (currentUserProfile && currentUserProfile.displayName) || '';
  }

  const isCaptain = currentUser && currentTeamRoles[currentUser.uid] === 'captain';

  const memberInfos = await Promise.all(teamData.members.map(uid => {
    if (uid === currentUser.uid) {
      // It's our own row — we already know our name/email/photo, no fetch needed
      return Promise.resolve({
        uid,
        displayName: typeof getCurrentUserDisplayName === 'function' ? getCurrentUserDisplayName() : (currentUser.email || 'You'),
        email: currentUser.email || '',
        photoURL: currentUser.photoURL || null
      });
    }
    return fetchMemberInfo(teamId, uid);
  }));

  // The team may have changed while these fetches were in flight
  if (currentTeamId !== teamId) return;

  memberList.innerHTML = '';
  status.textContent = `${teamData.members.length} member(s)`;

  memberInfos.forEach(({ uid, displayName, email, photoURL }) => {
    const item = document.createElement('div');
    item.className = 'member-item';

    // Avatar
    const avatar = document.createElement('img');
    avatar.className = 'member-avatar';
    avatar.src = photoURL || 'https://ui-avatars.com/api/?name=U&background=16213e&color=a0a0b8';
    avatar.alt = 'User';

    // Info
    const info = document.createElement('div');
    info.className = 'member-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'member-name';
    nameEl.textContent = uid === currentUser.uid ? `${displayName} (You)` : displayName;

    const emailEl = document.createElement('div');
    emailEl.className = 'member-email';
    emailEl.textContent = email;

    info.appendChild(nameEl);
    info.appendChild(emailEl);

    // Role badge
    const role = currentTeamRoles[uid] || 'member';
    const badge = document.createElement('span');
    badge.className = `member-role-badge ${role}`;
    badge.textContent = role === 'captain' ? 'Captain' : 'Member';

    item.appendChild(avatar);
    item.appendChild(info);
    item.appendChild(badge);

    // If current user is captain, show an "Edit Permissions" button for non-captain members
    if (isCaptain && role !== 'captain') {
      const editPermsBtn = document.createElement('button');
      editPermsBtn.className = 'btn btn-small btn-outline';
      editPermsBtn.style.marginLeft = '12px';
      editPermsBtn.textContent = 'Edit Permissions';
      editPermsBtn.addEventListener('click', () => openMemberPermissionsModal(uid));
      item.appendChild(editPermsBtn);
    } else if (role === 'captain' && isCaptain) {
      const captainNote = document.createElement('div');
      captainNote.style.fontSize = '11px';
      captainNote.style.color = 'var(--text-muted)';
      captainNote.style.marginLeft = '12px';
      captainNote.textContent = '(Full permissions)';
      item.appendChild(captainNote);
    }

    // If current user is captain and this member is not the captain, show "Make Captain" button
    if (isCaptain && uid !== currentUser.uid && role !== 'captain') {
      const makeCaptainBtn = document.createElement('button');
      makeCaptainBtn.className = 'btn btn-small btn-outline';
      makeCaptainBtn.style.marginLeft = '8px';
      makeCaptainBtn.textContent = 'Make Captain';
      makeCaptainBtn.addEventListener('click', () => transferCaptaincy(uid));
      item.appendChild(makeCaptainBtn);
    }

    memberList.appendChild(item);
  });
}

// ====== Resolve a member's display name/email/photo ahead of rendering ======
async function fetchMemberInfo(teamId, uid) {
  let displayName = uid;
  let photoURL = null;
  try {
    const userDoc = await db.collection('users').doc(uid).get();
    if (userDoc.exists) {
      const data = userDoc.data();
      displayName = data.displayName || uid;
      if (data.photoURL) photoURL = data.photoURL;
    }
  } catch (_) {
    // displayName stays as the uid fallback
  }

  // Email is private — reads the per-team copy at
  // teams/{teamId}/memberContacts/{uid}, visible to this team's captain or a
  // teammate with canViewMemberEmails; a permission-denied here just means
  // "don't show it."
  let email = '';
  try {
    const contactDoc = await db.collection('teams').doc(teamId).collection('memberContacts').doc(uid).get();
    email = contactDoc.exists ? (contactDoc.data().email || '') : '';
  } catch (_) {
    email = '';
  }

  return { uid, displayName, email, photoURL };
}

// ====== Edit Permissions Modal ======
const MEMBER_PERMISSION_KEYS = ['canEditTemplates', 'canEditOtherEntries', 'canBulkDelete', 'canPinEvents', 'canViewMemberEmails'];
let memberPermissionsEditingUid = null;

function openMemberPermissionsModal(uid) {
  memberPermissionsEditingUid = uid;
  const userPerms = currentTeamPermissions[uid] || {};

  MEMBER_PERMISSION_KEYS.forEach(key => {
    const checkbox = document.getElementById(`perm-${key}`);
    if (checkbox) checkbox.checked = userPerms[key] === true;
  });

  const errorEl = document.getElementById('member-permissions-error');
  if (errorEl) errorEl.textContent = '';

  document.getElementById('member-permissions-modal').classList.remove('hidden');
}

function closeMemberPermissionsModal() {
  memberPermissionsEditingUid = null;
  document.getElementById('member-permissions-modal').classList.add('hidden');
}

// ====== Save the edited member's permissions to Firestore ======
async function saveMemberPermissions() {
  if (!memberPermissionsEditingUid || !currentTeamId) return;
  const uid = memberPermissionsEditingUid;
  const errorEl = document.getElementById('member-permissions-error');

  const updates = {};
  const newPerms = {};
  MEMBER_PERMISSION_KEYS.forEach(key => {
    const checkbox = document.getElementById(`perm-${key}`);
    const value = checkbox ? checkbox.checked : false;
    updates[`permissions.${uid}.${key}`] = value;
    newPerms[key] = value;
  });

  try {
    await db.collection('teams').doc(currentTeamId).update(updates);

    currentTeamPermissions[uid] = { ...(currentTeamPermissions[uid] || {}), ...newPerms };
    if (currentTeamData) {
      currentTeamData.permissions = currentTeamPermissions;
    }
    closeMemberPermissionsModal();
  } catch (err) {
    console.error('Failed to update permissions:', err);
    if (errorEl) errorEl.textContent = 'Failed to save permissions. Check your connection.';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const cancelBtn = document.getElementById('btn-member-perms-cancel');
  const cancelInlineBtn = document.getElementById('btn-member-perms-cancel-inline');
  const overlay = document.getElementById('member-permissions-overlay');
  const saveBtn = document.getElementById('btn-member-perms-save');

  if (cancelBtn) cancelBtn.addEventListener('click', closeMemberPermissionsModal);
  if (cancelInlineBtn) cancelInlineBtn.addEventListener('click', closeMemberPermissionsModal);
  if (overlay) overlay.addEventListener('click', closeMemberPermissionsModal);
  if (saveBtn) saveBtn.addEventListener('click', saveMemberPermissions);
});

document.getElementById('input-display-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-save-display-name').click();
});

// ====== Save the current user's chosen display name ======
document.getElementById('btn-save-display-name').addEventListener('click', async () => {
  const input = document.getElementById('input-display-name');
  const status = document.getElementById('display-name-status');
  const name = input.value.trim();

  if (!name) {
    status.textContent = 'Please enter a name.';
    status.className = 'error-message';
    return;
  }
  if (!currentUser) return;

  try {
    await saveDisplayName(name);

    status.textContent = 'Saved!';
    status.className = 'success-message';
    setTimeout(() => { status.textContent = ''; }, 2000);

    // Refresh our own row in the member list to reflect the change immediately
    if (currentTeamId && currentTeamData) {
      loadTeamMembers(currentTeamId, currentTeamData);
    }
  } catch (err) {
    console.error('Failed to save display name:', err);
    status.textContent = 'Failed to save. Please try again.';
    status.className = 'error-message';
  }
});

// ====== Transfer captaincy to another member ======
async function transferCaptaincy(newCaptainUid) {
  if (!currentTeamId || !currentUser) return;

  if (!confirm(`Transfer captain role to this member? You will become a regular member.`)) return;

  showLoading('Transferring captain role...');
  try {
    // Update roles map: old captain becomes member, new captain becomes captain.
    // Both also get all four permissions granted explicitly — otherwise whoever
    // ends up depending on the permissions map (the demoted former captain now,
    // or the new captain if they're demoted later) would land on an effectively
    // empty one, since captains never previously needed a permissions entry.
    const fullPermissions = {
      canEditTemplates: true,
      canEditOtherEntries: true,
      canBulkDelete: true,
      canPinEvents: true
    };
    const updates = {};
    updates[`roles.${currentUser.uid}`] = 'member';
    updates[`roles.${newCaptainUid}`] = 'captain';
    updates[`permissions.${currentUser.uid}`] = fullPermissions;
    updates[`permissions.${newCaptainUid}`] = fullPermissions;

    await db.collection('teams').doc(currentTeamId).update(updates);

    hideLoading();
    // No manual reload needed — the live team doc listener (watchTeamDoc in auth.js)
    // picks up this update and refreshes currentTeamData / the member list for us.
  } catch (err) {
    hideLoading();
    console.error('Transfer captaincy error:', err);
    alert('Failed to transfer captain role. Check your connection and try again.');
  }
}

// ====== Leave Team (My Team tab) — same self-leave rule path as account
// deletion (selfLeaveTeam, defined in delete-account.js), but doesn't touch
// Firebase Auth or delete the account itself. Blocked for a captain while
// other members remain, exactly like account deletion. If this user is the
// team's LAST member, leaving deletes the entire team instead (also shared
// with account deletion — see deleteEntireTeam() in delete-account.js). ======
async function leaveTeam() {
  const errorEl = document.getElementById('leave-team-error');
  if (errorEl) errorEl.textContent = '';

  if (!currentUser || !currentTeamId) return;

  const isCaptain = typeof getCurrentUserRole === 'function' && getCurrentUserRole() === 'captain';
  const otherMembersExist = !!(currentTeamData && Array.isArray(currentTeamData.members) && currentTeamData.members.length > 1);

  if (isCaptain && otherMembersExist) {
    if (errorEl) errorEl.textContent = 'You must transfer the captain role to another member (above) before leaving.';
    return;
  }

  // The last remaining member is always its captain (see deleteEntireTeam()
  // for why) — leaving in that case deletes the entire team and its data,
  // not just this membership, so the confirm wording needs to say so.
  const isSoleMember = !!(currentTeamData && Array.isArray(currentTeamData.members) && currentTeamData.members.length === 1);
  const confirmMessage = isSoleMember
    ? "Leave this team? Since you're the last member, the ENTIRE team and all its data will be permanently deleted."
    : 'Leave this team? You can rejoin later with the join code.';
  if (!confirm(confirmMessage)) return;

  const leftTeamId = currentTeamId;
  const leftTeamData = currentTeamData;

  showLoading('Leaving team...');
  try {
    // Stop listeners tied to this team's data before removing it — same
    // teardown confirmDeleteAccount() already does, which leaveTeam() was
    // missing for the pit/match listeners (only watchTeamDoc was stopped).
    if (typeof watchTeamDoc === 'function') watchTeamDoc(null);
    if (typeof watchPitScoutStatus === 'function') watchPitScoutStatus(null);
    if (typeof watchMatchScoutStatus === 'function') watchMatchScoutStatus(null);

    if (isSoleMember) {
      if (typeof deleteEntireTeam === 'function') {
        await deleteEntireTeam(leftTeamId, currentUser.uid, leftTeamData);
      }
    } else if (typeof selfLeaveTeam === 'function') {
      await selfLeaveTeam(leftTeamId, currentUser.uid);
    }

    // Remove the left team from myTeams (multi-team support) — both branches
    // below depend on this already reflecting the team we just left.
    if (typeof myTeams !== 'undefined' && Array.isArray(myTeams)) {
      myTeams = myTeams.filter(t => t.id !== leftTeamId);
    }

    hideLoading();

    if (typeof myTeams !== 'undefined' && Array.isArray(myTeams) && myTeams.length > 0) {
      // Still a member of at least one other team — switch to it instead of
      // landing on the "no team" screen, which would be wrong here; leaving
      // one team doesn't mean the account has no team anymore.
      if (typeof switchActiveTeam === 'function') {
        switchActiveTeam(myTeams[0].id);
      }
    } else {
      // Genuinely their last team. Reset team-related state and land back on
      // the Join/Create screen — same shape as handleAuthenticatedUser()'s
      // "no team" branch. currentTeamId/currentTeamData/myTeams are reset by
      // showScreen() itself below.
      currentTeamRoles = {};
      currentTeamPermissions = {};
      if (typeof clearSelectedEvent === 'function') clearSelectedEvent();
      if (typeof clearSessionState === 'function') clearSessionState();

      const nameInput = document.getElementById('input-screen-team-display-name');
      if (nameInput) nameInput.value = (currentUserProfile && currentUserProfile.displayName) || '';

      showScreen('screen-team');
    }
  } catch (err) {
    hideLoading();
    console.error('Leave team error:', err);
    if (errorEl) errorEl.textContent = 'Failed to leave team. Please try again.';
  }
}

const btnLeaveTeam = document.getElementById('btn-leave-team');
if (btnLeaveTeam) btnLeaveTeam.addEventListener('click', leaveTeam);

// ====== Expose loadTeamMembers globally so auth.js can call it ======
window.loadTeamMembers = loadTeamMembers;
