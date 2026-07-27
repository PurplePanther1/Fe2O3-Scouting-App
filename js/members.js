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
    nameEl.textContent = uid === currentUser.uid ? 'You' : 'Loading...';

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

    // If current user is captain, show permission toggles for non-captain members (or even captain, but captain is always true)
    if (isCaptain && role !== 'captain') {
      const permsContainer = document.createElement('div');
      permsContainer.className = 'member-permissions';
      permsContainer.style.display = 'flex';
      permsContainer.style.flexDirection = 'column';
      permsContainer.style.gap = '4px';
      permsContainer.style.marginLeft = '12px';
      permsContainer.style.fontSize = '12px';

      const userPerms = currentTeamPermissions[uid] || {};

      // Toggle 1: Can edit templates
      const labelTmpl = document.createElement('label');
      labelTmpl.style.display = 'flex';
      labelTmpl.style.alignItems = 'center';
      labelTmpl.style.gap = '6px';
      labelTmpl.style.cursor = 'pointer';

      const checkboxTmpl = document.createElement('input');
      checkboxTmpl.type = 'checkbox';
      checkboxTmpl.checked = userPerms.canEditTemplates === true;
      checkboxTmpl.addEventListener('change', async () => {
        await updateMemberPermission(uid, 'canEditTemplates', checkboxTmpl.checked);
      });

      labelTmpl.appendChild(checkboxTmpl);
      labelTmpl.appendChild(document.createTextNode('Edit templates'));

      // Toggle 2: Can edit other entries
      const labelEntries = document.createElement('label');
      labelEntries.style.display = 'flex';
      labelEntries.style.alignItems = 'center';
      labelEntries.style.gap = '6px';
      labelEntries.style.cursor = 'pointer';

      const checkboxEntries = document.createElement('input');
      checkboxEntries.type = 'checkbox';
      checkboxEntries.checked = userPerms.canEditOtherEntries === true;
      checkboxEntries.addEventListener('change', async () => {
        await updateMemberPermission(uid, 'canEditOtherEntries', checkboxEntries.checked);
      });

      labelEntries.appendChild(checkboxEntries);
      labelEntries.appendChild(document.createTextNode("Edit others' entries"));

      permsContainer.appendChild(labelTmpl);
      permsContainer.appendChild(labelEntries);
      item.appendChild(permsContainer);
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

    // Fetch user display name in background
    fetchUserDisplayName(uid, nameEl, emailEl, avatar);
  }
}

// ====== Update member permission in Firestore ======
async function updateMemberPermission(uid, permissionKey, value) {
  if (!currentTeamId || !currentUser) return;
  try {
    const updates = {};
    updates[`permissions.${uid}.${permissionKey}`] = value;
    await db.collection('teams').doc(currentTeamId).update(updates);

    // Update local cache
    if (!currentTeamPermissions[uid]) {
      currentTeamPermissions[uid] = {};
    }
    currentTeamPermissions[uid][permissionKey] = value;
    if (currentTeamData) {
      currentTeamData.permissions = currentTeamPermissions;
    }
  } catch (err) {
    console.error('Failed to update permission:', err);
    alert('Failed to update permission. Check connection and permissions.');
    loadTeamMembers(currentTeamId, currentTeamData); // reload to reset UI
  }
}

// ====== Fetch user display name from Firebase Auth (via Firestore user profiles) ======
async function fetchUserDisplayName(uid, nameEl, emailEl, avatarEl) {
  try {
    // Try to get user profile from a users collection (if we stored one)
    const userDoc = await db.collection('users').doc(uid).get();
    if (userDoc.exists) {
      const data = userDoc.data();
      nameEl.textContent = data.displayName || data.email || uid;
      emailEl.textContent = data.email || uid;
      if (data.photoURL) {
        avatarEl.src = data.photoURL;
      }
      return;
    }
  } catch (_) {
    // Fall through to showing uid
  }
  // Fallback: just show the uid
  nameEl.textContent = uid;
  emailEl.textContent = '';
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
