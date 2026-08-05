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

  // If current user is captain, show "Edit Permissions" and "Grant All
  // Permissions" buttons for non-captain members
  if (isCaptain && role !== 'captain') {
    const editPermsBtn = document.createElement('button');
    editPermsBtn.className = 'btn btn-small btn-outline';
    editPermsBtn.style.marginLeft = '12px';
    editPermsBtn.textContent = 'Edit Permissions';
    editPermsBtn.addEventListener('click', () => openMemberPermissionsModal(uid));
    item.appendChild(editPermsBtn);

    const grantAllBtn = document.createElement('button');
    grantAllBtn.className = 'btn btn-small btn-outline btn-grant-all';
    grantAllBtn.style.marginLeft = '8px';
    applyGrantAllButtonFill(grantAllBtn, currentTeamPermissions[uid]);
    grantAllBtn.addEventListener('click', () => grantAllPermissions(uid, grantAllBtn));
    item.appendChild(grantAllBtn);
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
const MEMBER_PERMISSION_KEYS = ['canEditTemplates', 'canEditOtherEntries', 'canBulkDelete', 'canPinEvents', 'canViewMemberEmails'];
let memberPermissionsEditingUid = null;

// ====== "Grant All Permissions" fill indicator — shared by the row button
// (filled from the member's saved permissions, re-applied on every render)
// and the modal button (filled from the modal's live checkbox state, so it
// tracks ticks/unticks before Save is even pressed). ======
function grantAllFillPercent(permsObj) {
  const perms = permsObj || {};
  const grantedCount = MEMBER_PERMISSION_KEYS.filter(key => perms[key] === true).length;
  return Math.round((grantedCount / MEMBER_PERMISSION_KEYS.length) * 100);
}

function applyGrantAllButtonFill(btn, permsObj) {
  if (!btn) return;
  const percent = grantAllFillPercent(permsObj);
  const maxed = percent === 100;
  btn.classList.toggle('maxed', maxed);
  btn.textContent = maxed ? '✓ Grant All Permissions' : 'Grant All Permissions';
  btn.style.backgroundImage = maxed
    ? 'none'
    : `linear-gradient(to right, var(--success) ${percent}%, transparent ${percent}%)`;
}

// Re-reads the modal's own checkboxes (rather than currentTeamPermissions)
// so the button's fill tracks live edits before Save is pressed.
function updateGrantAllModalButtonFill() {
  const btn = document.getElementById('btn-member-perms-grant-all');
  if (!btn) return;
  const perms = {};
  MEMBER_PERMISSION_KEYS.forEach(key => {
    const checkbox = document.getElementById(`perm-${key}`);
    perms[key] = checkbox ? checkbox.checked : false;
  });
  applyGrantAllButtonFill(btn, perms);
}

function openMemberPermissionsModal(uid) {
  memberPermissionsEditingUid = uid;
  const userPerms = currentTeamPermissions[uid] || {};

  MEMBER_PERMISSION_KEYS.forEach(key => {
    const checkbox = document.getElementById(`perm-${key}`);
    if (checkbox) checkbox.checked = userPerms[key] === true;
  });
  updateGrantAllModalButtonFill();

  const errorEl = document.getElementById('member-permissions-error');
  if (errorEl) errorEl.textContent = '';

  document.getElementById('member-permissions-modal').classList.remove('hidden');
}

function closeMemberPermissionsModal() {
  memberPermissionsEditingUid = null;
  document.getElementById('member-permissions-modal').classList.add('hidden');
}

// ====== "Grant All Permissions" inside the modal — checks every box for the
// member currently being edited without saving; Save still has to be pressed
// to persist it, same as ticking each box by hand. ======
function checkAllMemberPermissionBoxes() {
  MEMBER_PERMISSION_KEYS.forEach(key => {
    const checkbox = document.getElementById(`perm-${key}`);
    if (checkbox) checkbox.checked = true;
  });
  // Programmatic .checked assignment doesn't fire a 'change' event, so the
  // fill indicator needs an explicit refresh here.
  updateGrantAllModalButtonFill();
}

// ====== "Grant All Permissions" row button — same end result as opening the
// modal, checking every box, and saving, but in one click. Captain-only,
// same as every other permission-editing control (openMemberPermissionsModal/
// saveMemberPermissions above); the write itself is also captain-gated
// server-side by the teams/{teamId} update rule. ======
async function grantAllPermissions(uid, btn) {
  if (!currentTeamId) return;

  const updates = {};
  const newPerms = {};
  MEMBER_PERMISSION_KEYS.forEach(key => {
    updates[`permissions.${uid}.${key}`] = true;
    newPerms[key] = true;
  });

  try {
    await db.collection('teams').doc(currentTeamId).update(updates);
    currentTeamPermissions[uid] = { ...(currentTeamPermissions[uid] || {}), ...newPerms };
    if (currentTeamData) {
      currentTeamData.permissions = currentTeamPermissions;
    }
    // The next live team-doc refresh will re-render this row (and its fill)
    // from scratch anyway, but updating the clicked button directly gives
    // instant feedback instead of waiting on that round trip.
    applyGrantAllButtonFill(btn, currentTeamPermissions[uid]);
  } catch (err) {
    console.error('Failed to grant all permissions:', err);
    alert('Failed to grant permissions. Check your connection and try again.');
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

  if (cancelBtn) cancelBtn.addEventListener('click', closeMemberPermissionsModal);
  if (cancelInlineBtn) cancelInlineBtn.addEventListener('click', closeMemberPermissionsModal);
  if (overlay) overlay.addEventListener('click', closeMemberPermissionsModal);
  if (saveBtn) saveBtn.addEventListener('click', saveMemberPermissions);
  if (grantAllBtn) grantAllBtn.addEventListener('click', checkAllMemberPermissionBoxes);

  // Keep the modal's Grant All button's fill in sync with the checkboxes as
  // the captain ticks/unticks them, before Save is even pressed.
  MEMBER_PERMISSION_KEYS.forEach(key => {
    const checkbox = document.getElementById(`perm-${key}`);
    if (checkbox) checkbox.addEventListener('change', updateGrantAllModalButtonFill);
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
async function transferCaptaincy(newCaptainUid) {
  if (!currentTeamId || !currentUser) return;

  if (!confirm(`Transfer captain role to this member? You will become a regular member.`)) return;

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
    alert('Failed to transfer captain role. Check your connection and try again.');
  }
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

    hideLoading();

    // Switch first, THEN show the success message — landing on the new
    // team's My Team tab already clears any leftover input/status as part
    // of activateDashboardTab()'s centralized clearing, so setting the
    // message after that (not before) is what keeps it from being wiped out
    // by the very switch this join triggers. The input field itself doesn't
    // need clearing here either, for the same reason.
    if (typeof switchActiveTeam === 'function') {
      switchActiveTeam(teamId);
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

    hideLoading();

    // Switch first, THEN show the success message — same reasoning as
    // joinAnotherTeam(): switching triggers activateDashboardTab()'s
    // centralized clearing, so setting the message after avoids it being
    // wiped out by the very switch this creation triggers.
    if (typeof switchActiveTeam === 'function') {
      switchActiveTeam(teamRef.id);
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
    // The set of teams changed — rebuild the per-team live listeners
    // (watchMyTeams(), auth.js): drops the one for the team just left.
    if (typeof watchMyTeams === 'function') watchMyTeams();
    // Same reasoning as joinAnotherTeam()/createAnotherTeam(): render off the
    // myTeams array synchronously rather than waiting on watchMyTeams()'s
    // async listeners, so the switcher hides/updates immediately.
    if (typeof renderTeamSwitcher === 'function') renderTeamSwitcher();

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
