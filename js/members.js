// ====== My Team Tab: Member List & Captain Management ======

let currentTeamId = null;
let currentTeamRoles = {};
let currentTeamPermissions = {};

// Caches each member's resolved display name/email/photo (fetchMemberInfo,
// below) across renders. loadTeamMembers() now builds every row immediately
// from data it already has (teamData.members + this cache) instead of
// waiting on a Promise.all of per-member fetches before rendering anything —
// a member seen before (an earlier render this session, e.g. before a
// permission-change refresh, or after switching teams and back) paints with
// real info on the very first frame; only a member never resolved before
// shows a brief "Loading…" placeholder until its own fetch finishes,
// independently of every other member's.
let memberInfoCache = {};

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

  // The My Team tab's "Join Another Team" input/status belong to whatever
  // attempt was last in progress — stale the moment ANY tab switch happens
  // (away from My Team, back to it, or through it after signing in/switching
  // teams/leaving one), since the field is only ever visible while this tab
  // is showing anyway. Centralized here rather than at each individual
  // trigger (sign-out, switchActiveTeam, leaveTeam, ...), same reasoning as
  // showScreen()'s screen-team field clearing.
  const joinAnotherTeamInput = document.getElementById('input-join-another-team-code');
  if (joinAnotherTeamInput) joinAnotherTeamInput.value = '';
  if (typeof clearStatusMessage === 'function') clearStatusMessage('join-another-team');

  const createAnotherTeamInput = document.getElementById('input-create-another-team-name');
  if (createAnotherTeamInput) createAnotherTeamInput.value = '';
  if (typeof clearStatusMessage === 'function') clearStatusMessage('create-another-team');

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

// ====== Team switcher (multi-team support) — populates the dropdown from
// myTeams (auth.js) and pre-selects the active team. Hidden entirely for a
// single-team account, matching how it looked before this existed. ======
function renderTeamSwitcher() {
  const section = document.getElementById('team-switcher-section');
  const select = document.getElementById('select-active-team');
  if (!section || !select) return;

  const teams = (typeof myTeams !== 'undefined' && Array.isArray(myTeams)) ? myTeams : [];

  if (teams.length <= 1) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');
  select.innerHTML = '';
  teams.forEach(t => {
    const option = document.createElement('option');
    option.value = t.id;
    const role = (currentUser && t.roles && t.roles[currentUser.uid] === 'captain') ? 'Captain' : 'Member';
    option.textContent = `${t.name || 'Unnamed team'} (${role})`;
    if (t.id === currentTeamId) option.selected = true;
    select.appendChild(option);
  });
}

document.getElementById('select-active-team').addEventListener('change', (e) => {
  const teamId = e.target.value;
  if (teamId && teamId !== currentTeamId && typeof switchActiveTeam === 'function') {
    switchActiveTeam(teamId);
  }
});

// ====== Load and display team members ======
// Renders every row immediately from data already on hand (teamData.members
// + memberInfoCache) instead of waiting on a Promise.all of per-member
// fetches first — a member resolved in an earlier render (this session)
// paints with real info on the very first frame; only a genuinely
// never-seen-before member shows a brief "Loading…" placeholder name until
// its own fetch resolves, independently of every other member's, and
// without blocking the rest of the list from appearing.
async function loadTeamMembers(teamId, teamData) {
  currentTeamId = teamId;
  currentTeamRoles = teamData.roles || {};
  currentTeamPermissions = teamData.permissions || {};

  renderTeamSwitcher();

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

  // Populate the display-name input with whatever this user has already chosen
  const nameInput = document.getElementById('input-display-name');
  if (nameInput) {
    nameInput.value = (currentUserProfile && currentUserProfile.displayName) || '';
  }

  const isCaptain = currentUser && currentTeamRoles[currentUser.uid] === 'captain';

  memberList.innerHTML = '';
  status.textContent = `${teamData.members.length} member(s)`;

  const rowRefs = {};
  teamData.members.forEach(uid => {
    const role = currentTeamRoles[uid] || 'member';
    const isSelf = uid === currentUser.uid;
    const info = isSelf
      ? {
          displayName: typeof getCurrentUserDisplayName === 'function' ? getCurrentUserDisplayName() : (currentUser.email || 'You'),
          email: currentUser.email || '',
          photoURL: currentUser.photoURL || null
        }
      : (memberInfoCache[uid] || { displayName: 'Loading…', email: '', photoURL: null });

    const row = buildMemberRow(uid, role, isCaptain, isSelf, info);
    memberList.appendChild(row.el);
    rowRefs[uid] = row;
  });

  // Fill in real display info for any member not already cached, each
  // independently as its own fetch resolves — a slow member no longer holds
  // up the rest of the list.
  teamData.members.forEach(uid => {
    if (uid === currentUser.uid || memberInfoCache[uid]) return;
    fetchMemberInfo(teamId, uid).then(info => {
      memberInfoCache[uid] = info;
      // The team may have changed, or this render superseded, while the
      // fetch was in flight.
      if (currentTeamId !== teamId) return;
      const row = rowRefs[uid];
      if (!row) return;
      row.nameEl.textContent = info.displayName;
      row.emailEl.textContent = info.email;
      if (info.photoURL) row.avatarEl.src = info.photoURL;
    }).catch(err => {
      console.warn(`Failed to load info for member ${uid}:`, err);
    });
  });
}

// ====== Build one member row — the DOM structure plus captain-only controls
// (Edit/Grant All Permissions, Make Captain), all of which only depend on
// role/uid and are available immediately. Returns the element plus refs to
// the name/email/avatar nodes so loadTeamMembers() can fill those in later
// without rebuilding the row. ======
function buildMemberRow(uid, role, isCaptain, isSelf, info) {
  const item = document.createElement('div');
  item.className = 'member-item';

  // Avatar
  const avatar = document.createElement('img');
  avatar.className = 'member-avatar';
  avatar.src = info.photoURL || 'https://ui-avatars.com/api/?name=U&background=16213e&color=a0a0b8';
  avatar.alt = 'User';

  // Info
  const infoEl = document.createElement('div');
  infoEl.className = 'member-info';

  const nameEl = document.createElement('div');
  nameEl.className = 'member-name';
  nameEl.textContent = isSelf ? `${info.displayName} (You)` : info.displayName;

  const emailEl = document.createElement('div');
  emailEl.className = 'member-email';
  emailEl.textContent = info.email;

  infoEl.appendChild(nameEl);
  infoEl.appendChild(emailEl);

  // Role badge
  const badge = document.createElement('span');
  badge.className = `member-role-badge ${role}`;
  badge.textContent = role === 'captain' ? 'Captain' : 'Member';

  item.appendChild(avatar);
  item.appendChild(infoEl);
  item.appendChild(badge);

  // If current user is captain, show "Edit Permissions" and a Grant All /
  // Remove All split button for non-captain members
  if (isCaptain && role !== 'captain') {
    const editPermsBtn = document.createElement('button');
    editPermsBtn.className = 'btn btn-small btn-outline';
    editPermsBtn.style.marginLeft = '12px';
    editPermsBtn.textContent = 'Edit Permissions';
    editPermsBtn.addEventListener('click', () => openMemberPermissionsModal(uid));
    item.appendChild(editPermsBtn);

    // Same continuous-fill split button as the Edit Permissions modal's, but
    // writing directly to Firestore on click (no modal/Save step) — same
    // immediate-write behavior the old single "Grant All Permissions" button
    // had. No .btn/.btn-outline class, so it sizes to its content here
    // rather than stretching (that stretch behavior is scoped to
    // .pit-modal-actions, which this row isn't part of).
    const grantRemoveSplit = document.createElement('div');
    grantRemoveSplit.className = 'perm-split-btn';
    grantRemoveSplit.style.marginLeft = '8px';
    applyGrantAllSplitFill(grantRemoveSplit, currentTeamPermissions[uid]);

    const removeAllHalf = document.createElement('button');
    removeAllHalf.type = 'button';
    removeAllHalf.className = 'perm-split-btn-half';
    removeAllHalf.textContent = 'Remove All';
    removeAllHalf.addEventListener('click', () => setAllPermissionsForMember(uid, false, grantRemoveSplit));
    grantRemoveSplit.appendChild(removeAllHalf);

    const grantAllHalf = document.createElement('button');
    grantAllHalf.type = 'button';
    grantAllHalf.className = 'perm-split-btn-half';
    grantAllHalf.textContent = 'Grant All';
    grantAllHalf.addEventListener('click', () => setAllPermissionsForMember(uid, true, grantRemoveSplit));
    grantRemoveSplit.appendChild(grantAllHalf);

    item.appendChild(grantRemoveSplit);
  } else if (role === 'captain' && isCaptain) {
    const captainNote = document.createElement('div');
    captainNote.style.fontSize = '11px';
    captainNote.style.color = 'var(--text-muted)';
    captainNote.style.marginLeft = '12px';
    captainNote.textContent = '(Full permissions)';
    item.appendChild(captainNote);
  }

  // If current user is captain and this member is not the captain, show "Make Captain" button
  if (isCaptain && !isSelf && role !== 'captain') {
    const makeCaptainBtn = document.createElement('button');
    makeCaptainBtn.className = 'btn btn-small btn-outline';
    makeCaptainBtn.style.marginLeft = '8px';
    makeCaptainBtn.textContent = 'Make Captain';
    makeCaptainBtn.addEventListener('click', () => transferCaptaincy(uid));
    item.appendChild(makeCaptainBtn);
  }

  // "Kick" — gated on canUserKickMembers() (captain OR the canKickMembers
  // permission), not on isCaptain like the block above, since this can be
  // granted to any member. Never shown on your own row or the captain's row
  // (the captain can't be kicked — also enforced server-side).
  if (!isSelf && role !== 'captain' && (typeof canUserKickMembers === 'function' ? canUserKickMembers() : false)) {
    const kickBtn = document.createElement('button');
    kickBtn.className = 'btn btn-small btn-outline';
    kickBtn.style.cssText = 'margin-left:8px; color:var(--error); border-color:var(--error);';
    kickBtn.textContent = 'Kick';
    kickBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      kickMember(uid);
    });
    item.appendChild(kickBtn);
  }

  // "My Permissions" — explicit button on your own row, the only way to
  // open it (no row-click trigger).
  if (isSelf) {
    const myPermsBtn = document.createElement('button');
    myPermsBtn.className = 'btn btn-small btn-outline';
    myPermsBtn.style.marginLeft = '12px';
    myPermsBtn.textContent = 'My Permissions';
    myPermsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof openMyPermissionsModal === 'function') openMyPermissionsModal();
    });
    item.appendChild(myPermsBtn);
  }

  return { el: item, nameEl, emailEl, avatarEl: avatar };
}

// ====== Resolve a member's display name/email/photo ahead of rendering ======
// The two reads are independent (different collections, different documents)
// so they run in parallel via Promise.allSettled rather than one after the
// other — sequential awaits here were roughly doubling this function's
// latency (and, since loadTeamMembers used to wait on every member's
// fetchMemberInfo before rendering anything, the whole list's) for no
// reason; a failure in one (e.g. memberContacts read denied) still shouldn't
// affect the other.
async function fetchMemberInfo(teamId, uid) {
  let displayName = uid;
  let photoURL = null;
  let email = '';

  const [userResult, contactResult] = await Promise.allSettled([
    db.collection('users').doc(uid).get(),
    db.collection('teams').doc(teamId).collection('memberContacts').doc(uid).get()
  ]);

  if (userResult.status === 'fulfilled' && userResult.value.exists) {
    const data = userResult.value.data();
    displayName = data.displayName || uid;
    if (data.photoURL) photoURL = data.photoURL;
  }

  // Email is private — reads the per-team copy at
  // teams/{teamId}/memberContacts/{uid}, visible to this team's captain or a
  // teammate with canViewMemberEmails; a permission-denied here just means
  // "don't show it."
  if (contactResult.status === 'fulfilled' && contactResult.value.exists) {
    email = contactResult.value.data().email || '';
  }

  return { uid, displayName, email, photoURL };
}

// ====== Edit Permissions Modal ======
const MEMBER_PERMISSION_KEYS = ['canEditTemplates', 'canEditOtherEntries', 'canBulkDelete', 'canPinEvents', 'canViewMemberEmails', 'canKickMembers'];

// Human-readable labels, matching the Edit Permissions modal's checkbox
// labels exactly — reused by the read-only "My Permissions" modal (below)
// so the two never drift apart.
const MEMBER_PERMISSION_LABELS = {
  canEditTemplates: 'Edit templates',
  canEditOtherEntries: "Edit others' entries",
  canBulkDelete: 'Bulk-delete entries',
  canPinEvents: 'Pin/unpin events',
  canViewMemberEmails: 'View member emails',
  canKickMembers: 'Kick members'
};
let memberPermissionsEditingUid = null;

// ====== Grant All / Remove All split-button fill indicator — shared by the
// row split button (filled from the member's saved permissions, re-applied
// on every render) and the modal's split button (filled from the modal's
// live checkbox state, so it tracks ticks/unticks before Save is even
// pressed). Applied to the CONTAINER (.perm-split-btn), not either half, so
// the fill reads as one continuous bar under both labels. ======
function grantAllFillPercent(permsObj) {
  const perms = permsObj || {};
  const grantedCount = MEMBER_PERMISSION_KEYS.filter(key => perms[key] === true).length;
  return Math.round((grantedCount / MEMBER_PERMISSION_KEYS.length) * 100);
}

function applyGrantAllSplitFill(containerEl, permsObj) {
  if (!containerEl) return;
  const percent = grantAllFillPercent(permsObj);
  const maxed = percent === 100;
  containerEl.classList.toggle('maxed', maxed);
  containerEl.style.backgroundImage = maxed
    ? 'none'
    : `linear-gradient(to right, var(--success) ${percent}%, transparent ${percent}%)`;
}

// Re-reads the modal's own checkboxes (rather than currentTeamPermissions)
// so the split button's fill tracks live edits before Save is pressed.
function updateGrantAllModalSplitFill() {
  const container = document.getElementById('perm-grant-remove-split');
  if (!container) return;
  const perms = {};
  MEMBER_PERMISSION_KEYS.forEach(key => {
    const checkbox = document.getElementById(`perm-${key}`);
    perms[key] = checkbox ? checkbox.checked : false;
  });
  applyGrantAllSplitFill(container, perms);
}

function openMemberPermissionsModal(uid) {
  memberPermissionsEditingUid = uid;
  const userPerms = currentTeamPermissions[uid] || {};

  MEMBER_PERMISSION_KEYS.forEach(key => {
    const checkbox = document.getElementById(`perm-${key}`);
    if (checkbox) checkbox.checked = userPerms[key] === true;
  });
  updateGrantAllModalSplitFill();

  const errorEl = document.getElementById('member-permissions-error');
  if (errorEl) errorEl.textContent = '';

  document.getElementById('member-permissions-modal').classList.remove('hidden');
}

function closeMemberPermissionsModal() {
  memberPermissionsEditingUid = null;
  document.getElementById('member-permissions-modal').classList.add('hidden');
}

// ====== Grant All / Remove All split button inside the modal — sets every
// box for the member currently being edited to the same value, without
// saving; Save still has to be pressed to persist it, same as ticking each
// box by hand. Remove All has no confirm dialog — low risk, since clicking
// Grant All immediately undoes it and nothing is written until Save. ======
function setAllMemberPermissionBoxes(value) {
  MEMBER_PERMISSION_KEYS.forEach(key => {
    const checkbox = document.getElementById(`perm-${key}`);
    if (checkbox) checkbox.checked = value;
  });
  // Programmatic .checked assignment doesn't fire a 'change' event, so the
  // fill indicator needs an explicit refresh here.
  updateGrantAllModalSplitFill();
}

// ====== "Grant All Permissions" / "Remove All Permissions" row split button
// — same end result as opening the modal, setting every box, and saving, but
// in one click, writing directly like the checkboxes never needed a Save
// step. Captain-only, same as every other permission-editing control
// (openMemberPermissionsModal/saveMemberPermissions above); the write itself
// is also captain-gated server-side by the teams/{teamId} update rule. No
// confirm dialog on Remove All — clicking Grant All immediately undoes it. ======
async function setAllPermissionsForMember(uid, value, containerEl) {
  if (!currentTeamId) return;

  const updates = {};
  const newPerms = {};
  MEMBER_PERMISSION_KEYS.forEach(key => {
    updates[`permissions.${uid}.${key}`] = value;
    newPerms[key] = value;
  });

  try {
    await db.collection('teams').doc(currentTeamId).update(updates);
    currentTeamPermissions[uid] = { ...(currentTeamPermissions[uid] || {}), ...newPerms };
    if (currentTeamData) {
      currentTeamData.permissions = currentTeamPermissions;
    }
    // The next live team-doc refresh will re-render this row (and its fill)
    // from scratch anyway, but updating the clicked split button directly
    // gives instant feedback instead of waiting on that round trip.
    applyGrantAllSplitFill(containerEl, currentTeamPermissions[uid]);
  } catch (err) {
    console.error(`Failed to ${value ? 'grant' : 'remove'} all permissions:`, err);
    if (typeof showNoticeModal === 'function') {
      showNoticeModal({
        title: 'Update Failed',
        message: `Failed to ${value ? 'grant' : 'remove'} permissions. Check your connection and try again.`
      });
    }
  }
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
  const grantAllBtn = document.getElementById('btn-member-perms-grant-all');
  const removeAllBtn = document.getElementById('btn-member-perms-remove-all');

  if (cancelBtn) cancelBtn.addEventListener('click', closeMemberPermissionsModal);
  if (cancelInlineBtn) cancelInlineBtn.addEventListener('click', closeMemberPermissionsModal);
  if (overlay) overlay.addEventListener('click', closeMemberPermissionsModal);
  if (saveBtn) saveBtn.addEventListener('click', saveMemberPermissions);
  if (grantAllBtn) grantAllBtn.addEventListener('click', () => setAllMemberPermissionBoxes(true));
  if (removeAllBtn) removeAllBtn.addEventListener('click', () => setAllMemberPermissionBoxes(false));

  // Keep the modal's split-button fill in sync with the checkboxes as the
  // captain ticks/unticks them, before Save is even pressed.
  MEMBER_PERMISSION_KEYS.forEach(key => {
    const checkbox = document.getElementById(`perm-${key}`);
    if (checkbox) checkbox.addEventListener('change', updateGrantAllModalSplitFill);
  });
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
function transferCaptaincy(newCaptainUid) {
  if (!currentTeamId || !currentUser || typeof showConfirmModal !== 'function') return;

  showConfirmModal({
    title: 'Transfer Captain Role?',
    message: 'Transfer captain role to this member? You will become a regular member.',
    confirmLabel: 'Transfer',
    danger: true,
    onConfirm: async () => {
      showLoading('Transferring captain role...');
      try {
        // Update roles map: old captain becomes member, new captain becomes captain.
        // Both also get every permission granted explicitly — otherwise whoever
        // ends up depending on the permissions map (the demoted former captain now,
        // or the new captain if they're demoted later) would land on an effectively
        // empty one, since captains never previously needed a permissions entry.
        // Built from MEMBER_PERMISSION_KEYS (defined above) rather than listed out
        // by hand, so a future new permission can't be missed here again the way
        // canViewMemberEmails was.
        const fullPermissions = {};
        MEMBER_PERMISSION_KEYS.forEach(key => { fullPermissions[key] = true; });
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
        if (typeof showNoticeModal === 'function') {
          showNoticeModal({
            title: 'Transfer Failed',
            message: 'Failed to transfer captain role. Check your connection and try again.'
          });
        }
      }
    }
  });
}

// ====== Join Another Team (My Team tab) — distinct from the initial
// Join/Create Team screen (screen-team), which is only for someone with zero
// teams. Reuses the same self-join write teams/{teamId}'s update rule
// already allows for any non-member, regardless of how many other teams
// they're already on. ======
async function joinAnotherTeam() {
  const input = document.getElementById('input-join-another-team-code');
  const setStatus = (type, message) => {
    if (typeof setStatusMessage === 'function') setStatusMessage('join-another-team', type, message);
  };

  setStatus('error', '');
  setStatus('success', '');

  const joinCode = input ? input.value.trim().toUpperCase() : '';
  if (!joinCode) {
    setStatus('error', 'Please enter a join code.');
    return;
  }
  if (!currentUser) {
    setStatus('error', 'You must be signed in to join a team.');
    return;
  }

  showLoading('Joining team...');
  try {
    const codeDoc = await db.collection('joinCodes').doc(joinCode).get();
    if (!codeDoc.exists) {
      hideLoading();
      setStatus('error', 'No team found with that join code. Check with your team lead.');
      return;
    }

    const teamId = codeDoc.data().teamId;

    // Already a member? The self-join write below only applies to a
    // non-member (see firestore.rules) — without this check, re-submitting
    // a code for a team already joined would just look like an unexplained
    // no-op rather than a clear "you're already on this team" message.
    const alreadyMember = typeof myTeams !== 'undefined' && Array.isArray(myTeams) && myTeams.some(t => t.id === teamId);
    if (alreadyMember) {
      hideLoading();
      setStatus('error', "You're already on this team.");
      return;
    }

    const teamRef = db.collection('teams').doc(teamId);

    // Scoped self-join: rules only allow this specific update (appending our
    // own uid and nothing else) for a non-member — same write team.js's
    // initial join flow uses.
    await teamRef.update({
      members: firebase.firestore.FieldValue.arrayUnion(currentUser.uid)
    });

    // A genuine (re)join is always a fresh start for this team's saved
    // event/search state — see team.js's initial join flow for the fuller
    // reasoning (this matters most for a team you were previously KICKED
    // from, since that leave-time clear can only ever run on the kicked
    // member's own client, never the kicker's).
    if (typeof clearTeamSessionState === 'function') {
      clearTeamSessionState(teamId);
    }

    const joinedSnap = await teamRef.get();
    const fullTeamData = { id: teamId, ...joinedSnap.data() };

    if (typeof ensureMemberContact === 'function') {
      await ensureMemberContact(teamId, currentUser.uid, (currentUserProfile && currentUserProfile.email) || currentUser.email || '');
    }

    // Add to myTeams and switch to it immediately — per design, joining
    // shouldn't leave the user looking at whichever team was already active.
    if (typeof myTeams !== 'undefined' && Array.isArray(myTeams)) {
      myTeams = [...myTeams, fullTeamData];
    }
    // The set of teams changed — rebuild the per-team live listeners
    // (watchMyTeams(), auth.js) so the newly joined team's entry stays live too.
    if (typeof watchMyTeams === 'function') watchMyTeams();
    // Render the switcher synchronously off the myTeams array we just updated,
    // rather than waiting on watchMyTeams()'s listeners (async — their first
    // event can lag a moment behind a just-completed write) or switchActiveTeam()
    // below (which only re-renders it as a side effect of watchTeamDoc's own
    // snapshot). Without this the switcher stayed hidden until either of those
    // eventually fired, which in practice could look like it needed a refresh.
    if (typeof renderTeamSwitcher === 'function') renderTeamSwitcher();
    if (typeof persistKnownTeamIds === 'function') persistKnownTeamIds();

    hideLoading();

    // Switch first, THEN show the success message — landing on the new
    // team's My Team tab already clears any leftover input/status as part
    // of activateDashboardTab()'s centralized clearing, so setting the
    // message after that (not before) is what keeps it from being wiped out
    // by the very switch this join triggers. The input field itself doesn't
    // need clearing here either, for the same reason. Awaited — switchActiveTeam()
    // is async now (it awaits restoring the new team's own event/search
    // state before its own activateDashboardTab() call), so without
    // awaiting it here, setStatus() below could still run before that
    // clearing happens and get wiped out by it arriving late.
    if (typeof switchActiveTeam === 'function') {
      await switchActiveTeam(teamId);
    }
    setStatus('success', `Joined "${fullTeamData.name || 'the team'}"!`);
  } catch (err) {
    hideLoading();
    console.error('Join another team error:', err);
    setStatus('error', 'Failed to join team. Please try again.');
  }
}

document.getElementById('btn-join-another-team').addEventListener('click', joinAnotherTeam);
document.getElementById('input-join-another-team-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinAnotherTeam();
});

// ====== Create a New Team (My Team tab) — distinct from the initial Create
// Team screen (screen-team), which is only for someone with zero teams.
// Same team-doc shape/writes as that flow (team.js's "Create Team" handler),
// but folds the result into myTeams and switches to it immediately instead of
// going through showScreen('screen-main')/resetDashboardOnEnterTeam(), same
// pattern as joinAnotherTeam() above. ======
async function createAnotherTeam() {
  const input = document.getElementById('input-create-another-team-name');
  const setStatus = (type, message) => {
    if (typeof setStatusMessage === 'function') setStatusMessage('create-another-team', type, message);
  };

  setStatus('error', '');
  setStatus('success', '');

  const teamName = input ? input.value.trim() : '';
  if (!teamName) {
    setStatus('error', 'Please enter a team name.');
    return;
  }
  if (!currentUser) {
    setStatus('error', 'You must be signed in to create a team.');
    return;
  }

  showLoading('Creating your team...');
  try {
    const joinCode = generateJoinCode(teamName);

    const codeDoc = await db.collection('joinCodes').doc(joinCode).get();
    if (codeDoc.exists) {
      // Extremely unlikely collision — just ask them to try again, same as
      // the onboarding create-team flow.
      hideLoading();
      setStatus('error', 'Please try again (code collision).');
      return;
    }

    const teamRef = db.collection('teams').doc();
    await teamRef.set({
      name: teamName,
      joinCode: joinCode,
      members: [currentUser.uid],
      roles: { [currentUser.uid]: 'captain' },
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: currentUser.uid
    });

    await db.collection('joinCodes').doc(joinCode).set({ teamId: teamRef.id });
    if (typeof ensureMemberContact === 'function') {
      await ensureMemberContact(teamRef.id, currentUser.uid, (currentUserProfile && currentUserProfile.email) || currentUser.email || '');
    }

    const createdSnap = await teamRef.get();
    const fullTeamData = { id: teamRef.id, ...createdSnap.data() };

    // Add to myTeams and switch to it immediately — same pattern as
    // joinAnotherTeam() above, including rendering the switcher synchronously
    // rather than waiting on watchMyTeams()'s async listeners.
    if (typeof myTeams !== 'undefined' && Array.isArray(myTeams)) {
      myTeams = [...myTeams, fullTeamData];
    }
    if (typeof watchMyTeams === 'function') watchMyTeams();
    if (typeof renderTeamSwitcher === 'function') renderTeamSwitcher();
    if (typeof persistKnownTeamIds === 'function') persistKnownTeamIds();

    hideLoading();

    // Switch first, THEN show the success message — same reasoning as
    // joinAnotherTeam(): switching triggers activateDashboardTab()'s
    // centralized clearing, so setting the message after avoids it being
    // wiped out by the very switch this creation triggers. Awaited for the
    // same reason as joinAnotherTeam() — switchActiveTeam() is async now.
    if (typeof switchActiveTeam === 'function') {
      await switchActiveTeam(teamRef.id);
    }
    setStatus('success', `Created "${fullTeamData.name || 'the team'}"!`);
  } catch (err) {
    hideLoading();
    console.error('Create another team error:', err);
    setStatus('error', 'Failed to create team. Please try again.');
  }
}

document.getElementById('btn-create-another-team').addEventListener('click', createAnotherTeam);
document.getElementById('input-create-another-team-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createAnotherTeam();
});

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
  // for why) — leaving in that case deletes the entire team and its data, not
  // just this membership. That case gets its own dedicated confirmation modal
  // (below) with an "Export Whole Team Data" option, since the export needs
  // its own button — the ordinary (non-last-member) case is low-risk (the
  // user can rejoin with the join code) and just uses the plain generic
  // confirm modal below instead of a dedicated one.
  const isSoleMember = !!(currentTeamData && Array.isArray(currentTeamData.members) && currentTeamData.members.length === 1);

  if (isSoleMember) {
    openLeaveTeamConfirmModal(currentTeamId, currentTeamData);
    return;
  }

  const teamId = currentTeamId;
  const teamData = currentTeamData;
  showConfirmModal({
    title: 'Leave Team?',
    message: 'Leave this team? You can rejoin later with the join code.',
    confirmLabel: 'Leave Team',
    danger: true,
    onConfirm: () => performLeaveTeam(false, teamId, teamData)
  });
}

// ====== Actually leave/delete the team — shared by the non-sole-member
// path above (its generic confirm modal's onConfirm) and the sole-member
// confirmation modal's "Leave & Delete Team" button (after the user has
// had the chance to export). Split out from leaveTeam() so the sole-member
// case can defer this until the user acts on the modal. ======
async function performLeaveTeam(isSoleMember, leftTeamId, leftTeamData) {
  const errorEl = document.getElementById('leave-team-error');
  if (errorEl) errorEl.textContent = '';

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
    } else {
      // Same anonymization confirmDeleteAccount() already does for a shared
      // team, and for the same reason it has to run BEFORE the self-leave
      // write below: the query inside it needs isTeamMember(teamId) to still
      // be true for this user, which stops being the case the instant
      // selfLeaveTeam() removes them from `members`.
      if (typeof anonymizeOwnScoutingEntries === 'function') {
        await anonymizeOwnScoutingEntries(leftTeamId, currentUser.uid);
      }
      // Mark this team as an expected self-removal right before the write
      // that triggers it — see markExpectedSelfRemoval()'s docblock. The
      // sole-member (deleteEntireTeam()) branch above doesn't need this: a
      // deleted team doc makes watchMyTeams()'s listener see doc.exists ===
      // false (its normal success path, already a silent no-notice no-op),
      // never a permission-denied error.
      markExpectedSelfRemoval(leftTeamId);
      if (typeof selfLeaveTeam === 'function') {
        await selfLeaveTeam(leftTeamId, currentUser.uid);
      }
    }

    hideLoading();
    navigateAwayFromRemovedTeam(leftTeamId);
  } catch (err) {
    hideLoading();
    console.error('Leave team error:', err);
    if (errorEl) errorEl.textContent = 'Failed to leave team. Please try again.';
  }
}

// ====== Shared post-removal navigation — used both when THIS client just
// performed the leave (performLeaveTeam(), above) and when this client
// discovers its active team was removed by someone else (a kick, detected
// reactively via handleRemovedFromTeam() below). Removes the team from
// myTeams, rebuilds the per-team live listeners, and lands on another team
// (if any remain) or the Join/Create screen — identical either way, since
// the end state ("no longer on this team") is the same regardless of who
// initiated the removal. Also persists the updated known-team-id set
// (offlineReconciliation, below) — this is what keeps a self-initiated
// Leave Team from misfiring as a "mystery removal" notice the next time
// this device opens the app. ======
function navigateAwayFromRemovedTeam(removedTeamId) {
  // Both branches below depend on this already reflecting the team just left.
  if (typeof myTeams !== 'undefined' && Array.isArray(myTeams)) {
    myTeams = myTeams.filter(t => t.id !== removedTeamId);
  }
  // The set of teams changed — rebuild the per-team live listeners
  // (watchMyTeams(), auth.js): drops the one for the team just left.
  if (typeof watchMyTeams === 'function') watchMyTeams();
  // Same reasoning as joinAnotherTeam()/createAnotherTeam(): render off the
  // myTeams array synchronously rather than waiting on watchMyTeams()'s
  // async listeners, so the switcher hides/updates immediately.
  if (typeof renderTeamSwitcher === 'function') renderTeamSwitcher();
  if (typeof persistKnownTeamIds === 'function') persistKnownTeamIds();

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
}

// ====== Teams this client is ABOUT to self-initiate removal from
// (performLeaveTeam(), below) — checked by handleRemovedFromTeam() so it
// can tell "I already know about this one, I'm handling it myself" apart
// from a genuinely externally-triggered kick. selfLeaveTeam()'s write
// removes this uid from `members` exactly the same way a kick does, so
// watchMyTeams()'s per-team listener sees the identical permission-denied
// error either way — there's no way to tell them apart from the listener's
// side alone, only from client-side knowledge of which one this is.
// Cleared as soon as it's consumed; also auto-expires as a safety net in
// case the expected error never actually arrives (e.g. the listener had
// already been torn down for some other reason), so a stale entry can
// never linger and wrongly suppress a real, later kick notice if this
// teamId is ever reused (left, then genuinely kicked after rejoining). ======
const expectedSelfRemovalTeamIds = new Set();

function markExpectedSelfRemoval(teamId) {
  expectedSelfRemovalTeamIds.add(teamId);
  setTimeout(() => expectedSelfRemovalTeamIds.delete(teamId), 10000);
}

// ====== React to being removed from a team by someone else (a kick) —
// called from watchMyTeams()'s per-team onSnapshot error callback (auth.js)
// when it fires 'permission-denied', which is what happens the instant this
// uid is no longer in that team's `members`: the read rule stops passing,
// Firestore terminates the listener rather than retrying it, and no final
// "you're out" snapshot is ever delivered. watchMyTeams() has a listener on
// EVERY team this user belongs to (not just the active one), so this single
// handler covers both cases:
//   - the removed team IS the active one: tear down its listeners, navigate
//     away FIRST (navigateAwayFromRemovedTeam()), THEN show the notice on
//     the new screen — never alert() before navigating, which left the user
//     staring at the old team's screen until they dismissed it.
//   - the removed team is a BACKGROUND one: just drop it from myTeams/the
//     switcher and show the same notice, without navigating — the user
//     isn't looking at it, so there's nothing to navigate away from. ======
function handleRemovedFromTeam(teamId) {
  if (expectedSelfRemovalTeamIds.has(teamId)) {
    expectedSelfRemovalTeamIds.delete(teamId);
    return;
  }

  const teamEntry = (typeof myTeams !== 'undefined' && Array.isArray(myTeams))
    ? myTeams.find(t => t.id === teamId)
    : null;
  const teamName = (teamEntry && teamEntry.name) || 'this team';

  if (currentTeamId === teamId) {
    if (typeof watchTeamDoc === 'function') watchTeamDoc(null);
    if (typeof watchPitScoutStatus === 'function') watchPitScoutStatus(null);
    if (typeof watchMatchScoutStatus === 'function') watchMatchScoutStatus(null);

    navigateAwayFromRemovedTeam(teamId);
  } else {
    if (typeof myTeams !== 'undefined' && Array.isArray(myTeams)) {
      myTeams = myTeams.filter(t => t.id !== teamId);
    }
    if (typeof watchMyTeams === 'function') watchMyTeams();
    if (typeof renderTeamSwitcher === 'function') renderTeamSwitcher();
    if (typeof persistKnownTeamIds === 'function') persistKnownTeamIds();
  }

  // Unlike the offline reconciliation notice (handleAuthenticatedUser(),
  // auth.js), this one knows for certain it wasn't a self-leave on this
  // device — it only ever fires from a live listener catching an
  // EXTERNALLY-triggered removal, so it can say "removed" plainly instead
  // of hedging with neutral wording. Queued (not shown directly) so
  // rapid-succession removals from multiple teams consolidate into one
  // message instead of clobbering each other — see queueRemovedTeamNotice().
  if (typeof queueRemovedTeamNotice === 'function') {
    queueRemovedTeamNotice(teamName);
  }
}

const btnLeaveTeam = document.getElementById('btn-leave-team');
if (btnLeaveTeam) btnLeaveTeam.addEventListener('click', leaveTeam);

// ====== Leave Team confirmation modal (sole-member case only, opened by
// leaveTeam() above) — lets the user export the team's full scouting history
// (openWholeTeamExportChoice(), sheets-export.js) before choosing to actually
// leave, which deletes the entire team and all its data. ======
let pendingLeaveTeamId = null;
let pendingLeaveTeamData = null;

function openLeaveTeamConfirmModal(teamId, teamData) {
  pendingLeaveTeamId = teamId;
  pendingLeaveTeamData = teamData;

  const messageEl = document.getElementById('leave-team-confirm-message');
  if (messageEl) {
    messageEl.textContent = `Leave "${teamData?.name || 'this team'}"? Since you're the last member, the ENTIRE team and all its data will be permanently deleted. Export it first if you want to keep a copy.`;
  }
  if (typeof clearStatusMessage === 'function') clearStatusMessage('leave-team-confirm-export');

  const modal = document.getElementById('leave-team-confirm-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeLeaveTeamConfirmModal() {
  pendingLeaveTeamId = null;
  pendingLeaveTeamData = null;
  if (typeof clearStatusMessage === 'function') clearStatusMessage('leave-team-confirm-export');
  const modal = document.getElementById('leave-team-confirm-modal');
  if (modal) modal.classList.add('hidden');
}

document.addEventListener('DOMContentLoaded', () => {
  const closeBtn = document.getElementById('btn-leave-team-confirm-close');
  if (closeBtn) closeBtn.addEventListener('click', closeLeaveTeamConfirmModal);

  const cancelBtn = document.getElementById('btn-leave-team-confirm-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', closeLeaveTeamConfirmModal);

  const overlay = document.getElementById('leave-team-confirm-modal-overlay');
  if (overlay) overlay.addEventListener('click', closeLeaveTeamConfirmModal);

  // Opens the shared export-choice modal (Excel vs Sheets) on top of this
  // one — same nested-modal pattern the Team Detail popup already uses for
  // its "Add/Edit Pit Scout" button. This modal stays open underneath so the
  // user lands back on it (with the export status inline) once they're done.
  const exportBtn = document.getElementById('btn-leave-team-confirm-export');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      if (pendingLeaveTeamId && typeof openWholeTeamExportChoice === 'function') {
        openWholeTeamExportChoice(pendingLeaveTeamId, pendingLeaveTeamData?.name, 'leave-team-confirm-export');
      }
    });
  }

  const proceedBtn = document.getElementById('btn-leave-team-confirm-proceed');
  if (proceedBtn) {
    proceedBtn.addEventListener('click', async () => {
      const teamId = pendingLeaveTeamId;
      const teamData = pendingLeaveTeamData;
      closeLeaveTeamConfirmModal();
      if (teamId) {
        await performLeaveTeam(true, teamId, teamData);
      }
    });
  }
});

// ====== Generic confirmation modal — replaces native confirm() for
// team-membership actions (Leave Team's plain case, Kick Member). Only one
// confirmation is ever pending at a time (matches confirm()'s own inherently
// blocking, one-at-a-time nature); the pending action is captured directly
// in the closure passed as onConfirm, so no extra pendingXId/pendingXData
// module state is needed the way the sole-member leave-team modal above has. ======
let pendingGenericConfirmCallback = null;

function showConfirmModal({ title, message, confirmLabel, danger, hideCancel, onConfirm }) {
  const titleEl = document.getElementById('generic-confirm-title');
  const messageEl = document.getElementById('generic-confirm-message');
  const proceedBtn = document.getElementById('btn-generic-confirm-proceed');
  const cancelBtn = document.getElementById('btn-generic-confirm-cancel');
  if (titleEl) titleEl.textContent = title || 'Confirm';
  if (messageEl) messageEl.textContent = message || '';
  if (proceedBtn) {
    proceedBtn.textContent = confirmLabel || 'Confirm';
    proceedBtn.style.cssText = danger ? 'background:var(--error); color:#fff; border-color:var(--error);' : '';
  }
  // Reset every call, not just when true — otherwise a hideCancel:true call
  // would leave Cancel hidden for the NEXT (normal) confirm too, since this
  // modal's markup is shared/reused rather than rebuilt per call.
  if (cancelBtn) cancelBtn.classList.toggle('hidden', !!hideCancel);
  pendingGenericConfirmCallback = typeof onConfirm === 'function' ? onConfirm : null;

  const modal = document.getElementById('generic-confirm-modal');
  if (modal) modal.classList.remove('hidden');
}

// ====== Pure-notice variant of the modal above — same styling, just OK/
// close with no Cancel (there's nothing to cancel, only to acknowledge).
// Used for the "removed from team" notices (handleRemovedFromTeam(),
// below) instead of alert(), which blocks on whatever screen was showing
// at the moment it fired rather than the screen the user's been navigated
// to by the time they see it. ======
function showNoticeModal({ title, message }) {
  showConfirmModal({ title, message, confirmLabel: 'OK', hideCancel: true, onConfirm: null });
}

function closeGenericConfirmModal() {
  pendingGenericConfirmCallback = null;
  // Whatever was showing (including a removed-teams notice — see
  // queueRemovedTeamNotice() below) is done with once this shared modal
  // closes, regardless of what closed it — this is the single teardown
  // point for every use of it, so resetting that tracking state here is
  // always safe.
  pendingRemovedTeamNames = [];
  removedTeamsNoticeShown = false;
  const modal = document.getElementById('generic-confirm-modal');
  if (modal) modal.classList.add('hidden');
}

// ====== Consolidate rapid-succession live removal notices — without this,
// two kicks landing close together each independently call showNoticeModal()
// on the same shared modal, and the second one simply overwrites the first
// before the user ever sees it (they'd only learn one team stopped working,
// never that they lost both). Buffers team names and either updates the
// notice already on screen in place, or briefly debounces before the FIRST
// display so several removals arriving within a short window still land as
// one consolidated message. The offline reconciliation notice
// (handleAuthenticatedUser(), auth.js) doesn't need this — it computes its
// full list synchronously in one pass, so there's nothing to race. ======
let pendingRemovedTeamNames = [];
let removedTeamsNoticeShown = false;
let removedTeamsNoticeDebounceTimer = null;

function renderRemovedTeamsNotice() {
  const names = pendingRemovedTeamNames;
  const message = names.length === 1
    ? `You've been removed from "${names[0]}".`
    : `You've been removed from these teams: ${names.map(n => `"${n}"`).join(', ')}.`;
  removedTeamsNoticeShown = true;
  showNoticeModal({ title: 'Removed from Team', message });
}

function queueRemovedTeamNotice(teamName) {
  if (!pendingRemovedTeamNames.includes(teamName)) {
    pendingRemovedTeamNames.push(teamName);
  }

  if (removedTeamsNoticeShown) {
    // Already on screen — update it in place. A debounce would never fire
    // again here anyway (it already fired once to get the modal open).
    renderRemovedTeamsNotice();
    return;
  }

  // Not shown yet — briefly debounce so several removals landing within a
  // few hundred ms of each other (the rapid-succession case) batch into the
  // first display instead of each one replacing the last before it's seen.
  if (removedTeamsNoticeDebounceTimer) clearTimeout(removedTeamsNoticeDebounceTimer);
  removedTeamsNoticeDebounceTimer = setTimeout(() => {
    removedTeamsNoticeDebounceTimer = null;
    renderRemovedTeamsNotice();
  }, 400);
}

document.addEventListener('DOMContentLoaded', () => {
  const closeBtn = document.getElementById('btn-generic-confirm-close');
  if (closeBtn) closeBtn.addEventListener('click', closeGenericConfirmModal);

  const cancelBtn = document.getElementById('btn-generic-confirm-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', closeGenericConfirmModal);

  const overlay = document.getElementById('generic-confirm-modal-overlay');
  if (overlay) overlay.addEventListener('click', closeGenericConfirmModal);

  const proceedBtn = document.getElementById('btn-generic-confirm-proceed');
  if (proceedBtn) {
    proceedBtn.addEventListener('click', async () => {
      const callback = pendingGenericConfirmCallback;
      closeGenericConfirmModal();
      if (callback) await callback();
    });
  }
});

// ====== Anonymize a KICKED member's attribution on the team's scouting
// entries — a targeted mirror of anonymizeOwnScoutingEntries() (delete-
// account.js), same two-query, one-field-at-a-time shape (scoutedBy ->
// scoutedByName, lastEditedBy -> lastEditedByName, queried and written
// separately since a single entry's departed scouter and still-present
// last-editor can be different people), but keyed off the kicked member's
// uid rather than the caller's own. Must run AFTER the membership removal
// succeeds (see kickMember()'s call site below) — the narrow
// canKickMembers-only carve-out in firestore.rules requires the target to
// already be out of `members` before it allows this write. A captain or
// canEditOtherEntries-holding kicker isn't affected by that ordering (their
// write permission doesn't depend on the target's membership status at
// all), so running it after is correct for every kicker permission
// combination, not just the narrow one. Best-effort, same as the self
// version: a failure on one document is logged and skipped rather than
// aborting the rest. ======
async function anonymizeKickedMembersScoutingEntries(teamId, targetUid) {
  const fieldPairs = [
    { queryField: 'scoutedBy', nameField: 'scoutedByName' },
    { queryField: 'lastEditedBy', nameField: 'lastEditedByName' }
  ];

  // pitScouting is now a teams/{teamId}/pitScouting subcollection, scoped by
  // path — no teamId where() clause needed. matchScouting is still the flat
  // top-level collection and still needs one — see anonymizeOwnScoutingEntries()
  // (delete-account.js) for the fuller reasoning, same pattern here.
  const collections = [
    { name: 'pitScouting', baseQuery: db.collection('teams').doc(teamId).collection('pitScouting') },
    { name: 'matchScouting', baseQuery: db.collection('matchScouting').where('teamId', '==', teamId) }
  ];

  for (const { name, baseQuery } of collections) {
    for (const { queryField, nameField } of fieldPairs) {
      try {
        const snap = await baseQuery.where(queryField, '==', targetUid).get();

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
        console.warn(`Failed to query ${name} by ${queryField} for kicked-member anonymization:`, err);
      }
    }
  }
}

// ====== Kick a member from the team — captain/canKickMembers-initiated
// removal, mirroring selfLeaveTeam()'s shape (remove from members, delete
// their roles/permissions entries, delete their memberContacts doc) but for
// a target uid instead of the caller's own. Unlike self-leave, this can
// never trigger a team deletion — the kicker always remains on the team
// afterward, and the captain can never be a kick target (also enforced
// server-side by the teams/{teamId} update rule's kick branch). Past pit/
// match entries the kicked member scouted are anonymized the same way
// Leave Team and Delete Account do (scoutedByName/lastEditedByName ->
// "Deleted User"), not deleted — see anonymizeKickedMembersScoutingEntries()
// above. Note: unlike selfLeaveTeam() (which runs on the leaving member's
// own client and can clear their sessionStorage), a kicked member's OWN
// per-team session state (session-state.js) can't be reached from the
// kicker's client — if they later rejoin on the same device, that old
// event/search state could still be sitting there. Low-severity (stale UI
// state, not a data/security issue) and inherent to being removed by
// someone else rather than leaving yourself. ======
async function kickMember(targetUid) {
  if (!currentTeamId || !currentUser) return;

  // Resolved fresh from memberInfoCache at call time rather than accepting
  // a name parameter bound when the row/button was built — the row's
  // "Loading…" placeholder info object (used before fetchMemberInfo()
  // resolves) doesn't get retroactively updated once the real name arrives,
  // only the DOM text does, so a captured value could go stale.
  const cachedInfo = (typeof memberInfoCache !== 'undefined') ? memberInfoCache[targetUid] : null;
  const targetName = (cachedInfo && cachedInfo.displayName) || 'this member';

  showConfirmModal({
    title: 'Kick Member?',
    message: `Remove "${targetName}" from the team? They can rejoin later with the join code. Their past scouting entries stay on the team.`,
    confirmLabel: 'Kick Member',
    danger: true,
    onConfirm: async () => {
      const teamId = currentTeamId;
      showLoading('Removing member...');
      try {
        const updates = {
          members: firebase.firestore.FieldValue.arrayRemove(targetUid)
        };
        updates[`roles.${targetUid}`] = firebase.firestore.FieldValue.delete();
        updates[`permissions.${targetUid}`] = firebase.firestore.FieldValue.delete();
        await db.collection('teams').doc(teamId).update(updates);

        // Must come after the membership removal above — see
        // anonymizeKickedMembersScoutingEntries()'s docblock for why.
        await anonymizeKickedMembersScoutingEntries(teamId, targetUid);

        try {
          await db.collection('teams').doc(teamId).collection('memberContacts').doc(targetUid).delete();
        } catch (err) {
          console.warn(`Failed to delete memberContacts for kicked member ${targetUid}:`, err);
        }

        hideLoading();
        // No manual reload needed — the live team doc listener (watchTeamDoc
        // in auth.js) picks up this update and refreshes currentTeamData /
        // the member list for us, same as transferCaptaincy().
      } catch (err) {
        hideLoading();
        console.error('Kick member error:', err);
        if (typeof showNoticeModal === 'function') {
          showNoticeModal({
            title: 'Remove Failed',
            message: 'Failed to remove member. Check your connection and try again.'
          });
        }
      }
    }
  });
}

// ====== My Permissions modal (read-only) — opened by clicking your own row
// in the member list (see buildMemberRow()). Shows only what you currently
// have, not the full list with unchecked boxes. Stays live while open:
// refreshActiveTeamData() (auth.js) calls renderMyPermissionsModal() on
// every live team-doc update, same mechanism already used for every other
// live-permission UI (updatePermissionUI(), the bulk-select toggles) — this
// just no-ops when the modal isn't currently open. ======
let myPermissionsModalOpen = false;

function renderMyPermissionsModal() {
  if (!myPermissionsModalOpen) return;

  const statusEl = document.getElementById('my-permissions-status');
  const listEl = document.getElementById('my-permissions-list');
  if (!statusEl || !listEl) return;

  listEl.innerHTML = '';

  if (typeof getCurrentUserRole === 'function' && getCurrentUserRole() === 'captain') {
    statusEl.textContent = "You're the captain — full permissions.";
    return;
  }

  const myPerms = (currentTeamPermissions && currentUser && currentTeamPermissions[currentUser.uid]) || {};
  const granted = MEMBER_PERMISSION_KEYS.filter(key => myPerms[key] === true);

  if (granted.length === 0) {
    statusEl.textContent = "You don't have any special permissions on this team.";
    return;
  }

  statusEl.textContent = 'You currently have:';
  granted.forEach(key => {
    const li = document.createElement('li');
    li.textContent = MEMBER_PERMISSION_LABELS[key] || key;
    listEl.appendChild(li);
  });
}

function openMyPermissionsModal() {
  myPermissionsModalOpen = true;
  renderMyPermissionsModal();
  const modal = document.getElementById('my-permissions-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeMyPermissionsModal() {
  myPermissionsModalOpen = false;
  const modal = document.getElementById('my-permissions-modal');
  if (modal) modal.classList.add('hidden');
}

document.addEventListener('DOMContentLoaded', () => {
  const closeBtn = document.getElementById('btn-my-permissions-close');
  if (closeBtn) closeBtn.addEventListener('click', closeMyPermissionsModal);

  const overlay = document.getElementById('my-permissions-modal-overlay');
  if (overlay) overlay.addEventListener('click', closeMyPermissionsModal);
});

// ====== Expose loadTeamMembers globally so auth.js can call it ======
window.loadTeamMembers = loadTeamMembers;
