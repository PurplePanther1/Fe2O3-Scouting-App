// ====== My Team Tab: Member List & Captain Management ======

let currentTeamId = null;
let currentTeamRoles = {};
let currentTeamPermissions = {};

// ====== Dashboard tab switching ======
document.querySelectorAll('#dashboard-tabs .tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#dashboard-tabs .tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const dtabName = tab.dataset.dtab;
    document.querySelectorAll('.dtab-content').forEach(tc => tc.classList.remove('active'));
    document.getElementById('dtab-' + dtabName).classList.add('active');
  });
});

// ====== Setup My Team copy button ======
setupCopyButton('btn-copy-myteam-code', 'myteam-join-code-value');

// ====== Load and display team members ======
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
  memberList.innerHTML = '';

  if (!teamData.members || teamData.members.length === 0) {
    status.textContent = 'No members found.';
    return;
  }

  status.textContent = `${teamData.members.length} member(s)`;

  // Populate the display-name input with whatever this user has already chosen
  const nameInput = document.getElementById('input-display-name');
  if (nameInput) {
    nameInput.value = (currentUserProfile && currentUserProfile.displayName) || '';
  }

  // Fetch user display info for each member
  const isCaptain = currentUser && currentTeamRoles[currentUser.uid] === 'captain';

  for (const uid of teamData.members) {
    const item = document.createElement('div');
    item.className = 'member-item';

    // Avatar
    const avatar = document.createElement('img');
    avatar.className = 'member-avatar';
    avatar.src = 'https://ui-avatars.com/api/?name=U&background=16213e&color=a0a0b8';
    avatar.alt = 'User';

    // Info
    const info = document.createElement('div');
    info.className = 'member-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'member-name';
    nameEl.textContent = uid === currentUser.uid
      ? `${typeof getCurrentUserDisplayName === 'function' ? getCurrentUserDisplayName() : (currentUser.email || 'You')} (You)`
      : 'Loading...';

    const emailEl = document.createElement('div');
    emailEl.className = 'member-email';
    emailEl.textContent = uid;

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

    if (uid === currentUser.uid) {
      // It's our own row — we already know our name/email/photo, no fetch needed
      emailEl.textContent = currentUser.email || '';
      if (currentUser.photoURL) avatar.src = currentUser.photoURL;
    } else {
      // Fetch user display name in background
      fetchUserDisplayName(uid, nameEl, emailEl, avatar);
    }
  }
}

// ====== Edit Permissions Modal ======
const MEMBER_PERMISSION_KEYS = ['canEditTemplates', 'canEditOtherEntries', 'canBulkDelete', 'canPinEvents'];
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
    await db.collection('users').doc(currentUser.uid).set({
      displayName: name,
      photoURL: currentUser.photoURL || null,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    currentUserProfile = { ...(currentUserProfile || {}), displayName: name };

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

// ====== Fetch user display name from Firestore user profiles ======
async function fetchUserDisplayName(uid, nameEl, emailEl, avatarEl) {
  try {
    const userDoc = await db.collection('users').doc(uid).get();
    if (userDoc.exists) {
      const data = userDoc.data();
      nameEl.textContent = data.displayName || uid;
      if (data.photoURL) {
        avatarEl.src = data.photoURL;
      }
    } else {
      nameEl.textContent = uid;
    }
  } catch (_) {
    nameEl.textContent = uid;
  }

  // Email is private — this resolves for the captain viewing a teammate, or the
  // user viewing themself; a permission-denied here just means "don't show it."
  try {
    const contactDoc = await db.collection('users').doc(uid).collection('private').doc('contact').get();
    emailEl.textContent = contactDoc.exists ? (contactDoc.data().email || '') : '';
  } catch (_) {
    emailEl.textContent = '';
  }
}

// ====== Transfer captaincy to another member ======
async function transferCaptaincy(newCaptainUid) {
  if (!currentTeamId || !currentUser) return;

  if (!confirm(`Transfer captain role to this member? You will become a regular member.`)) return;

  showLoading('Transferring captain role...');
  try {
    // Update roles map: old captain becomes member, new captain becomes captain
    const updates = {};
    updates[`roles.${currentUser.uid}`] = 'member';
    updates[`roles.${newCaptainUid}`] = 'captain';

    await db.collection('teams').doc(currentTeamId).update(updates);

    // Keep the userTeams pointers in sync with the new roles (must happen after
    // the roles update above, since the write rule validates against the real team doc)
    await db.collection('userTeams').doc(currentUser.uid).set({ teamId: currentTeamId, role: 'member' });
    await db.collection('userTeams').doc(newCaptainUid).set({ teamId: currentTeamId, role: 'captain' });

    hideLoading();
    // Reload the team data to refresh the UI
    const teamDoc = await db.collection('teams').doc(currentTeamId).get();
    if (teamDoc.exists) {
      const teamData = teamDoc.data();
      currentTeamRoles = teamData.roles || {};
      currentTeamData = { id: teamDoc.id, ...teamData };
      await loadTeamMembers(currentTeamId, teamData);
    }
  } catch (err) {
    hideLoading();
    console.error('Transfer captaincy error:', err);
    alert('Failed to transfer captain role. Check your connection and try again.');
  }
}

// ====== Expose loadTeamMembers globally so auth.js can call it ======
window.loadTeamMembers = loadTeamMembers;
