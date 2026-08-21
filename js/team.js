// ====== Team Join / Create Logic ======

// Store the current team data (set after create or join)
let currentTeamData = null;

// Tab switching (Join Team / Create Team on screen-team) — scoped to this
// screen specifically. This used to be a bare `.tab` selector, which matches
// every tab group in the app (auth tabs, dashboard tabs, scouting subtabs,
// builder tabs all share the `.tab` class) — clicking Join/Create, or Sign
// In/Sign Up on the login screen (same shared class), was wiping the `active`
// class off every tab everywhere else and never restoring it.
document.querySelectorAll('#screen-team .tab').forEach(tab => {
  tab.addEventListener('click', () => {
    // Update tab buttons
    document.querySelectorAll('#screen-team .tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');

    // Update tab content
    const tabName = tab.dataset.tab;
    if (tabName) {
      document.querySelectorAll('#screen-team .tab-content').forEach(tc => tc.classList.remove('active'));
      const contentEl = document.getElementById('tab-' + tabName);
      if (contentEl) {
        contentEl.classList.add('active');
      }
    }

    // Clear errors, and whatever code/name was entered on the tab being left —
    // same reasoning as switching between the Sign In/Sign Up tabs clearing
    // their own fields (clearAuthFormFields() in auth.js).
    clearErrors();
    const joinCodeInput = document.getElementById('input-join-code');
    if (joinCodeInput) joinCodeInput.value = '';
    const teamNameInput = document.getElementById('input-team-name');
    if (teamNameInput) teamNameInput.value = '';
  });
});

// ====== Reset screen-team's tabs to "Join Team" — the screen's own default,
// same idea as resetAuthTabs() (auth.js) always resetting Sign In/Sign Up
// back to Sign In. Without this, whichever tab was left active from a PRIOR
// account's session in this same browser tab (e.g. still on Create Team, if
// that's where a just-deleted account's session left off) would stay active
// instead of resetting, since nothing else re-applies the HTML's default. ======
function resetTeamTabs() {
  document.querySelectorAll('#screen-team .tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === 'join');
  });
  document.querySelectorAll('#screen-team .tab-content').forEach(c => {
    c.classList.toggle('active', c.id === 'tab-join');
  });
}

// ====== Reset to Scouting → Team Information the same way handleAuthenticatedUser()
// does on login. Called after create/join succeeds — without this, whatever
// dashboard tab was left active from a PRIOR account's session in this same
// browser tab (e.g. still on My Account, if that's where a just-deleted
// account's session left off) would stay active instead of resetting for a
// brand-new team, since create/join is a separate code path from login. ======
function resetDashboardOnEnterTeam() {
  // Always land on Scouting → Team Information here — unlike a refresh
  // (where restoring saved state is exactly the point), joining/creating a
  // team is always the START of a dashboard session in this tab, so there's
  // nothing legitimate to restore. Calling restoreOrDefaultSessionState()
  // here was wrong: it restores whatever's saved if anything is, and
  // browsing the standalone My Account view (before joining) saves
  // dashboardTab: 'account' as a side effect of activating that tab — which
  // then got restored right back after joining instead of defaulting.
  if (typeof window.activateDashboardTab === 'function') {
    window.activateDashboardTab('scouting');
  }
  if (typeof window.activateScoutingSubTab === 'function') {
    window.activateScoutingSubTab('info');
  }

  // Also reset the live selectedEvent/search-box state — unlike
  // switchActiveTeam() (auth.js), which calls restorePerTeamEventState() for
  // exactly this reason, nothing else on this path resets them. Without
  // this, whatever event/search text was still showing from before (most
  // notably: leaving one's LAST team lands on this same screen without ever
  // blanking the search box — navigateAwayFromRemovedTeam(), members.js,
  // only clears that team's OWN saved sessionStorage entry, not the live
  // DOM/in-memory state) would carry straight into the newly joined/created
  // team's view instead of starting fresh.
  const searchInput = document.getElementById('input-event-search');
  if (searchInput) searchInput.value = '';
  if (typeof clearSelectedEvent === 'function') {
    clearSelectedEvent();
  }
}

// ====== Derive a join-code prefix from the team's own name — first word,
// letters/digits only, uppercased, capped at 3 characters (e.g. "Magnesium"
// -> "MAG"). Falls back to a fixed prefix for a name with no usable
// characters (all symbols/emoji) or if somehow left blank. ======
function joinCodePrefixFromTeamName(teamName) {
  const firstWord = (teamName || '').trim().split(/\s+/)[0] || '';
  const cleaned = firstWord.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return cleaned.slice(0, 3) || 'TEAM';
}

// ====== Generate a random join code ======
// Suffix alternates number-letter-number-letter (e.g. "3F7K") rather than
// drawing all 4 characters from one mixed pool — since no two letters are
// ever adjacent, the suffix can never spell a real or inappropriate word,
// and since no two digits are ever adjacent either, it can never land on a
// problematic 2-digit segment.
function generateJoinCode(teamName) {
  const prefix = joinCodePrefixFromTeamName(teamName);
  const digits = '23456789'; // no 0, 1 to avoid confusion with O, I
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I, O to avoid confusion with 1, 0
  let suffix = '';
  for (let i = 0; i < 4; i++) {
    const pool = i % 2 === 0 ? digits : letters;
    suffix += pool.charAt(Math.floor(Math.random() * pool.length));
  }
  return `${prefix}-${suffix}`;
}

// ====== Show join code on dashboard ======
function showJoinCodeOnDashboard(joinCode) {
  const dashboardCode = document.getElementById('dashboard-join-code');
  const dashboardCodeValue = document.getElementById('dashboard-code-value');
  if (dashboardCode && dashboardCodeValue) {
    dashboardCodeValue.textContent = joinCode;
    dashboardCode.classList.remove('hidden');
  }
}

// ====== Copy to clipboard helper ======
function setupCopyButton(btnId, codeId) {
  const btn = document.getElementById(btnId);
  const codeEl = document.getElementById(codeId);
  if (!btn || !codeEl) return;

  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(codeEl.textContent);
      const originalText = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = originalText; }, 2000);
    } catch (err) {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = codeEl.textContent;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
    }
  });
}

// Setup copy buttons
setupCopyButton('btn-copy-created-code', 'created-join-code');
setupCopyButton('btn-copy-dashboard-code', 'dashboard-code-value');

// ====== Require a display name before finishing create/join. The field is always
// shown and pre-filled with any known name (see auth.js' handleAuthenticatedUser),
// but the user must still press Create/Join to confirm it — an auto-filled Google
// name is never used silently. Reuses the same saveDisplayName() write as the My
// Team tab's field. ======
async function ensureDisplayNameSet(errorElementId) {
  const input = document.getElementById('input-screen-team-display-name');
  const name = input ? input.value.trim() : '';
  if (!name) {
    showError(errorElementId, 'Please enter your display name to continue.');
    return false;
  }

  try {
    await saveDisplayName(name);
    return true;
  } catch (err) {
    console.error('Failed to save display name:', err);
    showError(errorElementId, 'Failed to save your display name. Please try again.');
    return false;
  }
}

// ====== Create Team ======
$('btn-create-team').addEventListener('click', async () => {
  clearErrors();
  const teamName = $('input-team-name').value.trim();

  if (!teamName) {
    showError('create-error', 'Please enter a team name.');
    return;
  }

  if (!currentUser) {
    showError('create-error', 'You must be signed in to create a team.');
    return;
  }

  if (!(await ensureDisplayNameSet('create-error'))) return;

  showLoading('Creating your team...');
  try {
    const joinCode = generateJoinCode(teamName);

    // Check if join code is unique via the public lookup collection (a plain
    // query against `teams` can't be used for this anymore now that team reads
    // are member-gated — a brand new team's creator isn't a member of anything yet)
    const codeDoc = await db.collection('joinCodes').doc(joinCode).get();
    if (codeDoc.exists) {
      // Extremely unlikely collision — just regenerate
      hideLoading();
      showError('create-error', 'Please try again (code collision).');
      return;
    }

    // Pre-generate the ID so we can create the team doc, then the joinCodes
    // lookup that validates against it, sequentially (avoids any ambiguity
    // around rules reading same-batch pending writes).
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
    await ensureMemberContact(teamRef.id, currentUser.uid, currentUserProfile?.email || currentUser.email || '');

    // Re-read the full team doc so currentTeamData gets the same complete
    // shape handleAuthenticatedUser() populates on login (members/roles/
    // permissions included). The previous {id, name, joinCode}-only object
    // left currentTeamId unset (only loadTeamMembers() sets it) and
    // permission checks reading an empty currentTeamData — silently broken
    // until the next refresh re-ran the full login flow.
    const createdSnap = await teamRef.get();
    const fullTeamData = { id: teamRef.id, ...createdSnap.data() };
    currentTeamData = fullTeamData;

    if (typeof loadTeamMembers === 'function') {
      loadTeamMembers(teamRef.id, fullTeamData);
    }
    if (typeof updatePermissionUI === 'function') {
      updatePermissionUI();
    }
    if (typeof watchTeamDoc === 'function') {
      watchTeamDoc(teamRef.id);
    }

    // This is the initial (zero-teams) onboarding flow — createAnotherTeam()
    // (members.js) already does this for an account that already has ≥1
    // team, but this path never did, leaving myTeams stale/empty and
    // watchMyTeams() (auth.js) without a listener for this team at all until
    // the next full login re-ran getUserTeams(). That's what let a kick (or
    // any other live team-doc change) on a team created this way go
    // undetected: watchTeamDoc() alone doesn't cover removal detection
    // anymore (see watchMyTeams()'s error callback) since that's now
    // centralized in watchMyTeams(), which had nothing registered here.
    if (typeof myTeams !== 'undefined' && Array.isArray(myTeams)) {
      myTeams = [...myTeams, fullTeamData];
    }
    if (typeof watchMyTeams === 'function') watchMyTeams();
    if (typeof renderTeamSwitcher === 'function') renderTeamSwitcher();
    if (typeof persistKnownTeamIds === 'function') persistKnownTeamIds();

    // Show the join code on the create tab
    const joinCodeCreated = document.getElementById('join-code-created');
    const createdJoinCode = document.getElementById('created-join-code');
    createdJoinCode.textContent = joinCode;
    joinCodeCreated.classList.remove('hidden');

    hideLoading();
    // Navigate to main app
    $('main-team-name').textContent = teamName;
    showJoinCodeOnDashboard(joinCode);
    showScreen('screen-main');
    resetDashboardOnEnterTeam();
  } catch (err) {
    hideLoading();
    console.error('Create team error:', err);
    showError('create-error', 'Failed to create team. Please try again.');
  }
});

// ====== Join Team ======
$('btn-join-team').addEventListener('click', async () => {
  clearErrors();
  const joinCode = $('input-join-code').value.trim().toUpperCase();

  if (!joinCode) {
    showError('join-error', 'Please enter a join code.');
    return;
  }

  if (!currentUser) {
    showError('join-error', 'You must be signed in to join a team.');
    return;
  }

  if (!(await ensureDisplayNameSet('join-error'))) return;

  showLoading('Joining team...');
  try {
    // Resolve the join code to a team ID via the public lookup collection —
    // a direct query against `teams` won't work for a non-member anymore.
    const codeDoc = await db.collection('joinCodes').doc(joinCode).get();
    if (!codeDoc.exists) {
      hideLoading();
      showError('join-error', 'No team found with that join code. Check with your team lead.');
      return;
    }

    const teamId = codeDoc.data().teamId;
    const teamRef = db.collection('teams').doc(teamId);

    // If we're already a member, we can read the doc directly and just go to the dashboard.
    try {
      const existingSnap = await teamRef.get();
      const existingData = existingSnap.data();
      if (existingData.members && existingData.members.includes(currentUser.uid)) {
        hideLoading();
        const fullTeamData = { id: teamId, ...existingData };
        currentTeamData = fullTeamData;
        if (typeof loadTeamMembers === 'function') {
          loadTeamMembers(teamId, fullTeamData);
        }
        if (typeof updatePermissionUI === 'function') {
          updatePermissionUI();
        }
        if (typeof watchTeamDoc === 'function') {
          watchTeamDoc(teamId);
        }
        // Same myTeams/watchMyTeams gap as the create-team flow above — see
        // that block's comment for why this matters (live removal
        // detection has nothing to detect with otherwise).
        if (typeof myTeams !== 'undefined' && Array.isArray(myTeams) && !myTeams.some(t => t.id === teamId)) {
          myTeams = [...myTeams, fullTeamData];
        }
        if (typeof watchMyTeams === 'function') watchMyTeams();
        if (typeof renderTeamSwitcher === 'function') renderTeamSwitcher();
        if (typeof persistKnownTeamIds === 'function') persistKnownTeamIds();
        $('main-team-name').textContent = existingData.name;
        showJoinCodeOnDashboard(existingData.joinCode);
        showScreen('screen-main');
        resetDashboardOnEnterTeam();
        return;
      }
    } catch (notYetMemberErr) {
      // Expected: reading the full team doc is denied until we're actually a member — fall through to join.
    }

    // Scoped self-join: rules only allow this specific update (appending our own uid
    // and nothing else) for a non-member, which is exactly what's happening here.
    await teamRef.update({
      members: firebase.firestore.FieldValue.arrayUnion(currentUser.uid)
    });

    // A genuine (re)join is always a fresh start for this team's saved
    // event/search state (session-state.js) — clearing here, not just on
    // the way out, is what makes this hold even when the PRIOR departure
    // was a kick (whose leave-time clear can only ever run on the KICKED
    // member's own client, and kickMember() has no way to reach into it —
    // sessionStorage is per-browser-tab) or somehow skipped its own
    // leave-time clear. A no-op if this team was never joined before.
    if (typeof clearTeamSessionState === 'function') {
      clearTeamSessionState(teamId);
    }

    // Now that we're a member, we can read the full doc.
    const joinedSnap = await teamRef.get();
    const teamData = joinedSnap.data();

    await ensureMemberContact(teamId, currentUser.uid, currentUserProfile?.email || currentUser.email || '');

    // Use the full team doc (members/roles/permissions included) rather than
    // just {id, name, joinCode} — same reason as the create-team flow above.
    const fullTeamData = { id: teamId, ...teamData };
    currentTeamData = fullTeamData;

    if (typeof loadTeamMembers === 'function') {
      loadTeamMembers(teamId, fullTeamData);
    }
    if (typeof updatePermissionUI === 'function') {
      updatePermissionUI();
    }
    if (typeof watchTeamDoc === 'function') {
      watchTeamDoc(teamId);
    }

    // Same myTeams/watchMyTeams gap as the create-team flow — see that
    // block's comment for why this matters.
    if (typeof myTeams !== 'undefined' && Array.isArray(myTeams)) {
      myTeams = [...myTeams, fullTeamData];
    }
    if (typeof watchMyTeams === 'function') watchMyTeams();
    if (typeof renderTeamSwitcher === 'function') renderTeamSwitcher();
    if (typeof persistKnownTeamIds === 'function') persistKnownTeamIds();

    hideLoading();
    $('main-team-name').textContent = teamData.name;
    showJoinCodeOnDashboard(teamData.joinCode);
    showScreen('screen-main');
    resetDashboardOnEnterTeam();
  } catch (err) {
    hideLoading();
    console.error('Join team error:', err);
    showError('join-error', 'Failed to join team. Please try again.');
  }
});

// Allow pressing Enter to submit
$('input-join-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-join-team').click();
});
$('input-team-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-create-team').click();
});