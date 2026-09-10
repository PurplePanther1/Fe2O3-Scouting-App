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

// ====== Reset to My Team the same way handleAuthenticatedUser() does on
// login. Called after create/join succeeds — without this, whatever
// dashboard tab was left active from a PRIOR account's session in this same
// browser tab (e.g. still on My Account, if that's where a just-deleted
// account's session left off) would stay active instead of resetting for a
// brand-new team, since create/join is a separate code path from login. ======
function resetDashboardOnEnterTeam() {
  // Always land on My Team here — unlike a refresh (where restoring saved
  // state is exactly the point), joining/creating a team is always the
  // START of a dashboard session in this tab, so there's nothing legitimate
  // to restore. Calling restoreOrDefaultSessionState() here was wrong: it
  // restores whatever's saved if anything is, and browsing the standalone
  // My Account view (before joining) saves dashboardTab: 'account' as a
  // side effect of activating that tab — which then got restored right back
  // after joining instead of defaulting.
  if (typeof window.activateDashboardTab === 'function') {
    window.activateDashboardTab('myteam');
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

// ====== Regenerate a team's join code (captain, or a member with the
// canRegenerateJoinCode permission) ======
// joinCode used to be bundled with name/roles/permissions/members as a
// strictly captain-only field on teams/{teamId} — it now has its own
// carve-out in firestore.rules (same pattern as pinnedEvents/canPinEvents),
// gated on canUserRegenerateJoinCode() (auth.js), which checks captain OR
// permissions[uid].canRegenerateJoinCode == true. Both client and server
// enforce the same condition independently.
//
// Sequence matters: update the team doc's joinCode FIRST, then create the
// new joinCodes/{newCode} lookup (its create rule checks that the team's
// OWN joinCode already equals the code being created — reads via get() in
// rules don't see other pending writes in the same batch, so this has to be
// two separate sequential writes, same reasoning as Create Team above), then
// delete the old joinCodes/{oldCode} lookup doc. That last delete is what
// actually makes the old code stop working — the join-by-code flow only
// checks whether a joinCodes/{code} doc exists, never whether it's still
// the team's CURRENT code, so leaving the old lookup doc in place would let
// it keep working forever. Current members are entirely unaffected: nothing
// here touches teams/{teamId}.members, and every live listener (watchTeamDoc)
// already re-renders myteam-join-code-value from teamData.joinCode on its own.
async function regenerateJoinCode() {
  if (typeof clearStatusMessage === 'function') clearStatusMessage('myteam-joincode');

  if (!currentTeamId || !currentTeamData) return;
  if (!(typeof canUserRegenerateJoinCode === 'function' && canUserRegenerateJoinCode())) return;

  const teamId = currentTeamId;
  const teamName = currentTeamData.name;
  const oldCode = currentTeamData.joinCode;

  if (typeof showConfirmModal !== 'function') return;
  showConfirmModal({
    title: 'Regenerate Join Code?',
    message: `This creates a new join code for "${teamName}" and immediately disables the old one${oldCode ? ` (${oldCode})` : ''}. Current members are not affected — only a future join attempt using the old code will stop working.`,
    confirmLabel: 'Regenerate',
    danger: true,
    onConfirm: async () => {
      showLoading('Regenerating join code...');
      try {
        // Extremely unlikely to collide even once — generateJoinCode() draws
        // from a large space — but retry a few times the same as Create Team
        // does, rather than surfacing a raw collision error to the user.
        let newCode = null;
        for (let attempt = 0; attempt < 5 && !newCode; attempt++) {
          const candidate = generateJoinCode(teamName);
          const codeDoc = await db.collection('joinCodes').doc(candidate).get();
          if (!codeDoc.exists) newCode = candidate;
        }
        if (!newCode) {
          const collisionErr = new Error('Please try again (code collision).');
          collisionErr.isKnownMessage = true;
          throw collisionErr;
        }

        const teamRef = db.collection('teams').doc(teamId);
        await teamRef.update({ joinCode: newCode });
        await db.collection('joinCodes').doc(newCode).set({ teamId, name: teamName });

        if (oldCode) {
          // Not best-effort: the join-by-code flow only checks whether a
          // joinCodes/{code} doc exists, never whether it's still the
          // team's current code — a failed delete here means the OLD code
          // would keep letting people join, so this has to be surfaced as
          // an error rather than swallowed.
          try {
            await db.collection('joinCodes').doc(oldCode).delete();
          } catch (cleanupErr) {
            console.warn('Failed to delete old joinCodes lookup doc:', cleanupErr);
            hideLoading();
            if (typeof setStatusMessage === 'function') {
              setStatusMessage('myteam-joincode', 'error', `New code is ${newCode}, but the old code (${oldCode}) may still work — failed to disable it. Try Regenerate again to clean it up.`);
            }
            return;
          }
        }

        hideLoading();
        if (typeof setStatusMessage === 'function') {
          setStatusMessage('myteam-joincode', 'success', `Join code regenerated — the old code no longer works.`);
        }
      } catch (err) {
        hideLoading();
        console.error('Regenerate join code error:', err);
        if (typeof setStatusMessage === 'function') {
          setStatusMessage('myteam-joincode', 'error', (err && err.isKnownMessage && err.message) || 'Failed to regenerate join code. Please try again.');
        }
      }
    }
  });
}

const btnRegenerateJoinCode = document.getElementById('btn-regenerate-join-code');
if (btnRegenerateJoinCode) btnRegenerateJoinCode.addEventListener('click', regenerateJoinCode);

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

// ====== Create Team ======
// Account-level display name is already confirmed before a user can reach
// this screen at all (see auth.js' handleAuthenticatedUser() and the
// screen-set-display-name gate) — this handler doesn't need to check it.
//
// The team name is already typed into the input, so the per-team-name popup
// can show immediately, BEFORE any write — clicking Create just opens it;
// the actual team-creation write only happens once THAT'S confirmed (inside
// onConfirm below). Cancelling the popup creates nothing at all.
$('btn-create-team').addEventListener('click', () => {
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

  if (typeof openTeamDisplayNameModal !== 'function') return;

  openTeamDisplayNameModal({
    teamName,
    confirmLabel: 'Create Team',
    onConfirm: async (chosenName) => {
      showLoading('Creating your team...');
      try {
        const joinCode = generateJoinCode(teamName);

        // Check if join code is unique via the public lookup collection (a plain
        // query against `teams` can't be used for this anymore now that team reads
        // are member-gated — a brand new team's creator isn't a member of anything yet)
        const codeDoc = await db.collection('joinCodes').doc(joinCode).get();
        if (codeDoc.exists) {
          // Extremely unlikely collision — just ask them to retry. Marked so
          // the catch below preserves this specific message instead of
          // overwriting it with the generic one.
          const collisionErr = new Error('Please try again (code collision).');
          collisionErr.isKnownMessage = true;
          throw collisionErr;
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

        await db.collection('joinCodes').doc(joinCode).set({ teamId: teamRef.id, name: teamName });
        await ensureMemberContact(teamRef.id, currentUser.uid, currentUserProfile?.email || currentUser.email || '');

        // Per-team name override — only if it differs from the account
        // default they were shown, same "blank/unchanged means inherit the
        // account name" reasoning as savePerTeamDisplayName() (auth.js).
        const accountName = (currentUserProfile && currentUserProfile.displayName) || '';
        if (chosenName && chosenName !== accountName) {
          await db.collection('teams').doc(teamRef.id).collection('memberDisplayNames').doc(currentUser.uid).set({ displayName: chosenName });
        }

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
        $('main-team-name').textContent = teamName;
        showJoinCodeOnDashboard(joinCode);
        showScreen('screen-main');
        resetDashboardOnEnterTeam();
      } catch (err) {
        hideLoading();
        console.error('Create team error:', err);
        throw (err && err.isKnownMessage) ? err : new Error('Failed to create team. Please try again.');
      }
    },
    onCancel: () => {
      // Nothing was written — stay on screen-team, name still in the input.
    }
  });
});

// ====== Join Team ======
// Same account-name reasoning as Create Team above.
//
// The join code is resolved to a team id (and, when available, its name —
// see joinCodes/{code}'s "name" field) via a READ-ONLY lookup first — the
// membership-adding write only happens inside the popup's onConfirm below,
// same "nothing committed until confirmed" structure as Create Team.
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
    // Only present on joinCodes docs written after the name field was added
    // (this create-team flow, and the ensureJoinCodeDoc() backfill) — older
    // codes fall back to the modal's own generic wording.
    const resolvedTeamName = codeDoc.data().name || null;
    const teamRef = db.collection('teams').doc(teamId);

    // If we're already a member, we can read the doc directly and just go to
    // the dashboard — this isn't a fresh join, so no name popup here at all.
    let existingFullTeamData = null;
    try {
      const existingSnap = await teamRef.get();
      const existingData = existingSnap.data();
      if (existingData.members && existingData.members.includes(currentUser.uid)) {
        existingFullTeamData = { id: teamId, ...existingData };
      }
    } catch (notYetMemberErr) {
      // Expected: reading the full team doc is denied until we're actually a member — fall through to join.
    }

    hideLoading();

    if (existingFullTeamData) {
      currentTeamData = existingFullTeamData;
      if (typeof loadTeamMembers === 'function') loadTeamMembers(teamId, existingFullTeamData);
      if (typeof updatePermissionUI === 'function') updatePermissionUI();
      if (typeof watchTeamDoc === 'function') watchTeamDoc(teamId);
      // Same myTeams/watchMyTeams gap as the create-team flow above — see
      // that block's comment for why this matters (live removal
      // detection has nothing to detect with otherwise).
      if (typeof myTeams !== 'undefined' && Array.isArray(myTeams) && !myTeams.some(t => t.id === teamId)) {
        myTeams = [...myTeams, existingFullTeamData];
      }
      if (typeof watchMyTeams === 'function') watchMyTeams();
      if (typeof renderTeamSwitcher === 'function') renderTeamSwitcher();
      if (typeof persistKnownTeamIds === 'function') persistKnownTeamIds();
      $('main-team-name').textContent = existingFullTeamData.name;
      showJoinCodeOnDashboard(existingFullTeamData.joinCode);
      showScreen('screen-main');
      resetDashboardOnEnterTeam();
      return;
    }

    if (typeof openTeamDisplayNameModal !== 'function') return;

    openTeamDisplayNameModal({
      teamName: resolvedTeamName,
      confirmLabel: 'Join Team',
      onConfirm: async (chosenName) => {
        showLoading('Joining team...');
        try {
          // Scoped self-join: rules only allow this specific update (appending
          // our own uid and nothing else) for a non-member, which is exactly
          // what's happening here. This is the actual join — the first write
          // in this whole flow.
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

          // Per-team name override — only if it differs from the account
          // default they were shown.
          const accountName = (currentUserProfile && currentUserProfile.displayName) || '';
          if (chosenName && chosenName !== accountName) {
            await db.collection('teams').doc(teamId).collection('memberDisplayNames').doc(currentUser.uid).set({ displayName: chosenName });
          }

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
          throw new Error('Failed to join team. Please try again.');
        }
      },
      onCancel: () => {
        // Nothing was written — stay on screen-team.
      }
    });
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